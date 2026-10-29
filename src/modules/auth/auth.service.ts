import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService, type JwtSignOptions } from '@nestjs/jwt'
import bcrypt from 'bcryptjs'

import { parseDurationSeconds } from '@/common/duration.util'
import { hashSessionSecret, verifySessionSecret } from '@/common/session-hash.util'
import { encodeSessionToken, generateSessionSecret, parseSessionToken } from '@/common/session-token.util'
import { PrismaService } from '@/database/prisma.service'
import { BCRYPT_COST, toAuthUser, USER_SELECT } from '@/modules/auth/auth-user'
import type { AuthProfile, AuthResult, AuthUser, RequestContext } from '@/modules/auth/auth.types'
import { VerificationService } from '@/modules/auth/verification.service'
import { Prisma } from '@prisma-client'

// A valid pre-computed hash compared against when the account does not exist, so a
// failed login costs roughly the same time whether or not the email is registered.
const TIMING_GUARD_HASH = '$2b$12$aOsoBnv7iRSo.MqU2AmZwuNTXjLNKisRV3PMfTwFj6YZ3G/t53Puu'

const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
const ROTATION_GRACE_MS = 30_000
const REFRESH_REJECTED = 'Invalid or expired refresh token'

const SESSION_INCLUDE = {
  user: { select: USER_SELECT },
} satisfies Prisma.SessionInclude

type SessionWithUser = Prisma.SessionGetPayload<{ include: typeof SESSION_INCLUDE }>

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  private readonly accessTtl: JwtSignOptions['expiresIn']
  private readonly refreshTtlSeconds: number

  private readonly recentRotations = new Map<string, { secret: string; until: number }>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly verification: VerificationService,
    config: ConfigService,
  ) {
    this.accessTtl = config.get<string>('jwt.expiresIn', '15m') as JwtSignOptions['expiresIn']
    this.refreshTtlSeconds = parseDurationSeconds(
      config.get<string>('jwt.refreshExpiresIn', '7d'),
      DEFAULT_REFRESH_TTL_SECONDS,
    )
  }

  async register(email: string, password: string, ctx: RequestContext): Promise<AuthResult> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST)

    let user: AuthUser
    try {
      user = toAuthUser(await this.prisma.user.create({ data: { email, passwordHash }, select: USER_SELECT }))
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email is already registered')
      }
      throw error
    }

    this.logger.log(`Registered new user <${user.email}>`)
    const result = await this.issueTokens(user, ctx)
    try {
      await this.verification.sendVerification(user)
    } catch (error) {
      this.logger.error(`Verification email for user ${user.id} not queued: ${(error as Error).message}`)
    }
    return result
  }

  async login(email: string, password: string, ctx: RequestContext): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { ...USER_SELECT, passwordHash: true },
    })

    const matches = await bcrypt.compare(password, user?.passwordHash ?? TIMING_GUARD_HASH)

    if (!user || !matches) {
      throw new UnauthorizedException('Invalid email or password')
    }

    return this.issueTokens(toAuthUser(user), ctx)
  }

  async refresh(rawToken: string, ctx: RequestContext): Promise<AuthResult> {
    const parsed = parseSessionToken(rawToken)
    if (!parsed) {
      throw new UnauthorizedException(REFRESH_REJECTED)
    }

    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
      include: SESSION_INCLUDE,
    })

    if (!session) {
      throw new UnauthorizedException(REFRESH_REJECTED)
    }

    const now = Date.now()

    if (session.expiresAt.getTime() <= now) {
      await this.discard(session.id)
      throw new UnauthorizedException(REFRESH_REJECTED)
    }

    const withinGrace = session.rotatedAt !== null && now - session.rotatedAt.getTime() < ROTATION_GRACE_MS

    if (verifySessionSecret(parsed.secret, session.tokenHash)) {
      return withinGrace ? this.reissue(session, parsed.secret) : this.rotate(session, ctx)
    }

    if (session.prevTokenHash && verifySessionSecret(parsed.secret, session.prevTokenHash)) {
      if (withinGrace) {
        const current = this.recentRotations.get(session.id)
        if (current && current.until > now) {
          return this.reissue(session, current.secret)
        }
        throw new UnauthorizedException(REFRESH_REJECTED)
      }

      await this.discard(session.id)
      this.logger.warn(
        `Refresh token reuse detected for session ${session.id} (user ${session.userId}) — session revoked`,
      )
      throw new UnauthorizedException(REFRESH_REJECTED)
    }

    throw new UnauthorizedException(REFRESH_REJECTED)
  }

  async logout(sessionId: string): Promise<void> {
    const { count } = await this.prisma.session.deleteMany({ where: { id: sessionId } })
    if (count > 0) {
      this.logger.log(`Session ${sessionId} terminated`)
    }
  }

  async logoutAll(userId: string): Promise<void> {
    const { count } = await this.prisma.session.deleteMany({ where: { userId } })
    this.logger.log(`All sessions terminated for user ${userId} (${count})`)
  }

  async profile(userId: string): Promise<AuthProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...USER_SELECT, createdAt: true },
    })

    if (!user) {
      throw new UnauthorizedException('Account no longer exists')
    }

    return { ...toAuthUser(user), createdAt: user.createdAt }
  }

  private async issueTokens(user: AuthUser, ctx: RequestContext): Promise<AuthResult> {
    const secret = await generateSessionSecret()

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionSecret(secret),
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        expiresAt: this.refreshExpiresAt(),
      },
      select: { id: true },
    })

    const accessToken = await this.signAccessToken(user, session.id)

    return { user, accessToken, refreshToken: encodeSessionToken(session.id, secret) }
  }

  private async rotate(session: SessionWithUser, ctx: RequestContext): Promise<AuthResult> {
    const secret = await generateSessionSecret()
    const now = Date.now()
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, tokenHash: session.tokenHash },
      data: {
        tokenHash: hashSessionSecret(secret),
        prevTokenHash: session.tokenHash,
        rotatedAt: new Date(now),
        generation: { increment: 1 },
        expiresAt: this.refreshExpiresAt(),
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    })

    if (count === 0) {
      const current = this.recentRotations.get(session.id)
      if (current && current.until > now) {
        return this.reissue(session, current.secret)
      }
      throw new UnauthorizedException(REFRESH_REJECTED)
    }

    this.rememberRotation(session.id, secret, now)

    return this.reissue(session, secret)
  }

  private async reissue(session: SessionWithUser, secret: string): Promise<AuthResult> {
    const user = toAuthUser(session.user)
    const accessToken = await this.signAccessToken(user, session.id)
    return { user, accessToken, refreshToken: encodeSessionToken(session.id, secret) }
  }

  private rememberRotation(sessionId: string, secret: string, now: number): void {
    this.recentRotations.set(sessionId, { secret, until: now + ROTATION_GRACE_MS })

    if (this.recentRotations.size > 1024) {
      for (const [id, entry] of this.recentRotations) {
        if (entry.until <= now) {
          this.recentRotations.delete(id)
        }
      }
    }
  }

  private signAccessToken(user: AuthUser, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, email: user.email, type: 'access', sid: sessionId },
      { expiresIn: this.accessTtl },
    )
  }

  private refreshExpiresAt(): Date {
    return new Date(Date.now() + this.refreshTtlSeconds * 1000)
  }

  private async discard(sessionId: string): Promise<void> {
    try {
      await this.prisma.session.deleteMany({ where: { id: sessionId } })
    } catch (error) {
      this.logger.warn(`Failed to discard session ${sessionId}: ${(error as Error).message}`)
    }
  }
}
