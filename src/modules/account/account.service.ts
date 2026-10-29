import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import bcrypt from 'bcryptjs'

import { PrismaService } from '@/database/prisma.service'
import { MailService } from '@/mail/mail.service'
import { BCRYPT_COST } from '@/modules/auth/auth-user'
import { InvalidPasswordException } from '@/modules/auth/auth.errors'
import type { RequestContext } from '@/modules/auth/auth.types'
import { VerificationService } from '@/modules/auth/verification.service'
import { CreateQuotaService } from '@/modules/urls/create-quota.service'
import { UrlsService } from '@/modules/urls/urls.service'
import { Prisma, VerificationTokenType } from '@prisma-client'

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly verification: VerificationService,
    private readonly urls: UrlsService,
    private readonly quota: CreateQuotaService,
  ) {}

  /** Sets a new password and revokes every session of the account except `keepSessionId`. */
  async changePassword(
    userId: string,
    keepSessionId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.checkPassword(userId, currentPassword)
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST)
    const changedAt = new Date()

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: changedAt },
        select: { id: true },
      }),
      this.prisma.session.deleteMany({ where: { userId, id: { not: keepSessionId } } }),
      this.prisma.verificationToken.deleteMany({ where: { userId, type: VerificationTokenType.PASSWORD_RESET } }),
    ])

    this.logger.log(`Password changed for user ${userId}; other sessions revoked`)
    this.mail.sendPasswordChanged(user.email, { changedAt, ip: ctx.ip })
  }

  async requestEmailChange(userId: string, newEmail: string, password: string, ctx: RequestContext): Promise<void> {
    const user = await this.checkPassword(userId, password)
    if (newEmail === user.email) {
      throw new BadRequestException('This is already the email address of the account')
    }
    await this.verification.requestEmailChange(user, newEmail, ctx)
  }

  /**
   * Deletes the account with its sessions, emailed links and every link it owns, then drops the
   * links' cached destinations and unflushed clicks so none of them resolves again.
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.checkPassword(userId, password)

    let shortCodes: string[]
    try {
      shortCodes = await this.prisma.$transaction(async (tx) => {
        const codes = await this.urls.deleteAllForUser(tx, userId)
        await tx.user.delete({ where: { id: userId }, select: { id: true } })
        return codes
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new UnauthorizedException('Account no longer exists')
      }
      throw error
    }

    await this.urls.forget(shortCodes)
    await this.quota.forget(userId)

    this.logger.log(`Account ${userId} deleted with ${shortCodes.length} link(s)`)
    this.mail.sendAccountDeleted(user.email)
  }

  private async checkPassword(userId: string, password: string): Promise<{ id: string; email: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    })
    if (!user) {
      throw new UnauthorizedException('Account no longer exists')
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new InvalidPasswordException()
    }
    return { id: user.id, email: user.email }
  }
}
