import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import bcrypt from 'bcryptjs'

import { hashSessionSecret } from '@/common/session-hash.util'
import { generateSessionSecret } from '@/common/session-token.util'
import { PrismaService } from '@/database/prisma.service'
import {
  EMAIL_CHANGE_TTL_MINUTES,
  EMAIL_VERIFY_TTL_MINUTES,
  MailService,
  PASSWORD_RESET_TTL_MINUTES,
} from '@/mail/mail.service'
import { BCRYPT_COST, toAuthUser, USER_SELECT } from '@/modules/auth/auth-user'
import { EmailCooldownException, InvalidTokenException } from '@/modules/auth/auth.errors'
import type { AuthUser, RequestContext } from '@/modules/auth/auth.types'
import { CaptchaService } from '@/modules/auth/captcha.service'
import { EmailCooldownService } from '@/modules/auth/email-cooldown.service'
import { Prisma, VerificationTokenType } from '@prisma-client'

type Tx = Prisma.TransactionClient

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly cooldown: EmailCooldownService,
    private readonly captcha: CaptchaService,
  ) {}

  /** Emails a fresh confirmation link; earlier links stop working. */
  async sendVerification(user: { id: string; email: string }): Promise<void> {
    await this.cooldown.acquire(`verify:${user.id}`)
    const token = await this.issue(user.id, VerificationTokenType.EMAIL_VERIFY, EMAIL_VERIFY_TTL_MINUTES)
    this.mail.sendEmailVerification(user.email, token)
  }

  /** Throws `EmailCooldownException` while the previous email's cooldown runs; a no-op once verified. */
  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    })
    if (!user) {
      throw new UnauthorizedException('Account no longer exists')
    }
    if (user.emailVerifiedAt) return

    const retryAfter = await this.cooldown.acquire(`verify:${user.id}`)
    if (retryAfter > 0) {
      throw new EmailCooldownException(retryAfter)
    }

    const token = await this.issue(user.id, VerificationTokenType.EMAIL_VERIFY, EMAIL_VERIFY_TTL_MINUTES)
    this.mail.sendEmailVerification(user.email, token)
  }

  async verifyEmail(token: string): Promise<AuthUser> {
    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await this.claim(tx, VerificationTokenType.EMAIL_VERIFY, token)
      if (!claimed) return null

      await tx.verificationToken.deleteMany({
        where: { userId: claimed.userId, type: VerificationTokenType.EMAIL_VERIFY },
      })
      await tx.user.updateMany({
        where: { id: claimed.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      })
      return tx.user.findUniqueOrThrow({ where: { id: claimed.userId }, select: USER_SELECT })
    })

    if (!user) {
      throw new InvalidTokenException()
    }

    this.logger.log(`Email verified for user ${user.id}`)
    return toAuthUser(user)
  }

  /**
   * Emails a reset link when `email` belongs to an account. Runs in the background and never throws,
   * so the response neither waits on it nor reveals by its timing whether the account exists.
   */
  requestPasswordReset(email: string): void {
    this.sendPasswordReset(email).catch((error: unknown) => {
      this.logger.error(`Password reset request failed: ${(error as Error).message}`)
    })
  }

  /** Sets the password, confirms the email address, revokes every session and lifts the failed sign-in count. */
  async resetPassword(token: string, password: string, ctx: RequestContext): Promise<void> {
    const known = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashSessionSecret(token) },
      select: { id: true },
    })
    if (!known) {
      throw new InvalidTokenException()
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
    const changedAt = new Date()

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await this.claim(tx, VerificationTokenType.PASSWORD_RESET, token)
      if (!claimed) return null

      await tx.verificationToken.deleteMany({
        where: { userId: claimed.userId, type: VerificationTokenType.PASSWORD_RESET },
      })
      await tx.session.deleteMany({ where: { userId: claimed.userId } })
      await tx.user.updateMany({
        where: { id: claimed.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: changedAt },
      })
      return tx.user.update({
        where: { id: claimed.userId },
        data: { passwordHash, passwordChangedAt: changedAt },
        select: { id: true, email: true },
      })
    })

    if (!user) {
      throw new InvalidTokenException()
    }

    this.logger.log(`Password reset for user ${user.id}; all sessions revoked`)
    await this.captcha.clearLoginFailures(user.email)
    this.mail.sendPasswordChanged(user.email, { changedAt, ip: ctx.ip })
  }

  /**
   * Emails a confirmation link to `newEmail` and a notice to the current address. Throws
   * `EmailCooldownException` while the previous request's cooldown runs. Whether `newEmail` is free
   * is checked only on confirmation, so the request does not reveal which addresses are registered.
   */
  async requestEmailChange(user: { id: string; email: string }, newEmail: string, ctx: RequestContext): Promise<void> {
    const retryAfter = await this.cooldown.acquire(`change:${user.id}`)
    if (retryAfter > 0) {
      throw new EmailCooldownException(retryAfter)
    }

    const token = await this.issue(user.id, VerificationTokenType.EMAIL_CHANGE, EMAIL_CHANGE_TTL_MINUTES, newEmail)
    this.mail.sendEmailChangeVerification(newEmail, token)
    this.mail.sendEmailChangeRequested(user.email, { newEmail, requestedAt: new Date(), ip: ctx.ip })
  }

  /**
   * Moves the account to the address the token was issued for and marks it confirmed. Every other
   * emailed link of the account stops working, so a reset link sent to the old address cannot be used.
   * Throws `ConflictException` when another account took the address in the meantime.
   */
  async confirmEmailChange(token: string): Promise<AuthUser> {
    const changedAt = new Date()
    let result: { user: AuthUser; previousEmail: string } | null
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const claimed = await this.claim(tx, VerificationTokenType.EMAIL_CHANGE, token)
        if (!claimed?.newEmail) return null

        const previous = await tx.user.findUniqueOrThrow({ where: { id: claimed.userId }, select: { email: true } })
        await tx.verificationToken.deleteMany({ where: { userId: claimed.userId } })
        const user = await tx.user.update({
          where: { id: claimed.userId },
          data: { email: claimed.newEmail, emailVerifiedAt: changedAt },
          select: USER_SELECT,
        })
        return { user: toAuthUser(user), previousEmail: previous.email }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email is already registered')
      }
      throw error
    }

    if (!result) {
      throw new InvalidTokenException()
    }

    this.logger.log(`Email changed for user ${result.user.id}`)
    this.mail.sendEmailChanged(result.previousEmail, { newEmail: result.user.email, changedAt })
    return result.user
  }

  async sweepExpired(): Promise<number> {
    const { count } = await this.prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    return count
  }

  private async sendPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true } })
    if (!user) return

    if ((await this.cooldown.acquire(`reset:${user.id}`)) > 0) return

    const token = await this.issue(user.id, VerificationTokenType.PASSWORD_RESET, PASSWORD_RESET_TTL_MINUTES)
    this.mail.sendPasswordReset(user.email, token)
  }

  private async issue(
    userId: string,
    type: VerificationTokenType,
    ttlMinutes: number,
    newEmail?: string,
  ): Promise<string> {
    const token = await generateSessionSecret()
    await this.prisma.$transaction([
      this.prisma.verificationToken.deleteMany({ where: { userId, type } }),
      this.prisma.verificationToken.create({
        data: {
          userId,
          type,
          newEmail,
          tokenHash: hashSessionSecret(token),
          expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        },
        select: { id: true },
      }),
    ])
    return token
  }

  /**
   * Deletes the token if it is of `type` and unexpired, and returns its owner. Of two concurrent
   * claims on one token, only one gets it: the loser's delete waits for the winner and finds no row.
   */
  private async claim(
    tx: Tx,
    type: VerificationTokenType,
    token: string,
  ): Promise<{ userId: string; newEmail: string | null } | null> {
    const row = await tx.verificationToken.findUnique({
      where: { tokenHash: hashSessionSecret(token) },
      select: { id: true, userId: true, type: true, newEmail: true, expiresAt: true },
    })
    if (!row || row.type !== type || row.expiresAt.getTime() <= Date.now()) return null

    const { count } = await tx.verificationToken.deleteMany({ where: { id: row.id } })
    return count === 1 ? { userId: row.userId, newEmail: row.newEmail } : null
  }
}
