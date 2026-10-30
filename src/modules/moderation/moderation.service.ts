import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Redis } from 'ioredis'

import { PrismaService } from '@/database/prisma.service'
import { MailService } from '@/mail/mail.service'
import { isEmailTarget, parseShortCode } from '@/modules/moderation/moderation-target'
import { InjectRedis } from '@/redis/redis.constants'
import { evictUrls } from '@/modules/urls/url-cache'
import { UrlDisabledReason } from '@prisma-client'

/** An operator mistake, such as an unknown code or address; the message is meant for the operator. */
export class ModerationError extends Error {}

export type DisableReason = typeof UrlDisabledReason.MANUAL | typeof UrlDisabledReason.UNSAFE_DESTINATION

export interface LinkOutcome {
  shortCode: string
  /** `false` when the link already was in the requested state. */
  changed: boolean
  disabledReason: UrlDisabledReason | null
  ownerEmail: string | null
}

export interface UserOutcome {
  userId: string
  email: string
  /** `false` when the account already was in the requested state. */
  changed: boolean
  /** Links disabled by a suspension, or re-enabled by lifting it. */
  shortCodes: string[]
}

/**
 * Disables links and suspends accounts. Every change evicts the cached resolutions it affects, so
 * redirects follow it at once, and emails the owner.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name)
  private readonly baseUrl: string

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('shortener.baseUrl', 'http://localhost:3000')
  }

  /** The short code in `target` (a code or a short URL). Throws `ModerationError` when there is none. */
  shortCodeOf(target: string): string {
    const shortCode = parseShortCode(target)
    if (shortCode === null) {
      throw new ModerationError(`"${target}" is not a short code or short URL`)
    }
    return shortCode
  }

  /** The account `target` names: an email address, or a short code or short URL of one of its links. */
  async findUserId(target: string): Promise<string> {
    if (isEmailTarget(target)) {
      const user = await this.prisma.user.findUnique({
        where: { email: target.trim().toLowerCase() },
        select: { id: true },
      })
      if (!user) {
        throw new ModerationError(`No account with the email address "${target}"`)
      }
      return user.id
    }

    const shortCode = this.shortCodeOf(target)
    const url = await this.prisma.url.findUnique({ where: { shortCode }, select: { userId: true } })
    if (!url) {
      throw new ModerationError(`No link with the short code "${shortCode}"`)
    }
    if (url.userId === null) {
      throw new ModerationError(`The link "${shortCode}" has no owner`)
    }
    return url.userId
  }

  /**
   * Disables `shortCode` for `reason`. A manual disable replaces any other reason; an unsafe-destination
   * disable never replaces a manual one, so the owner can't lift it by editing the link.
   */
  async disableLink(shortCode: string, reason: DisableReason): Promise<LinkOutcome> {
    const url = await this.findLink(shortCode)
    const ownerEmail = url.user?.email ?? null

    const keeps =
      url.disabledReason === reason ||
      (reason === UrlDisabledReason.UNSAFE_DESTINATION && url.disabledReason === UrlDisabledReason.MANUAL)
    if (keeps) {
      return { shortCode, changed: false, disabledReason: url.disabledReason, ownerEmail }
    }

    await this.prisma.url.update({
      where: { shortCode },
      data: { disabledAt: url.disabledAt ?? new Date(), disabledReason: reason },
      select: { id: true },
    })
    await evictUrls(this.redis, [shortCode], this.logger)
    this.logger.log(`Link "${shortCode}" disabled (${reason})`)

    if (ownerEmail !== null && url.disabledAt === null) {
      this.mail.sendLinkDisabled(ownerEmail, {
        shortUrl: this.shortUrl(shortCode),
        reason: reason === UrlDisabledReason.MANUAL ? 'manual' : 'unsafe',
      })
    }
    return { shortCode, changed: true, disabledReason: reason, ownerEmail }
  }

  /**
   * Re-enables `shortCode`. While the owner is suspended the link instead waits for the suspension to
   * be lifted (`ACCOUNT_SUSPENDED`), so it never resolves for a suspended account.
   */
  async enableLink(shortCode: string): Promise<LinkOutcome> {
    const url = await this.findLink(shortCode)
    const ownerEmail = url.user?.email ?? null
    const reason = url.user?.suspendedAt ? UrlDisabledReason.ACCOUNT_SUSPENDED : null

    if (url.disabledReason === reason) {
      return { shortCode, changed: false, disabledReason: reason, ownerEmail }
    }

    await this.prisma.url.update({
      where: { shortCode },
      data: { disabledAt: reason === null ? null : (url.disabledAt ?? new Date()), disabledReason: reason },
      select: { id: true },
    })
    await evictUrls(this.redis, [shortCode], this.logger)
    this.logger.log(`Link "${shortCode}" ${reason === null ? 'enabled' : 'left disabled until the owner is restored'}`)

    if (ownerEmail !== null && reason === null) {
      this.mail.sendLinkEnabled(ownerEmail, { shortUrl: this.shortUrl(shortCode) })
    }
    return { shortCode, changed: true, disabledReason: reason, ownerEmail }
  }

  /** Suspends the account: signs it out everywhere and disables every link that is still enabled. */
  async suspendUser(userId: string): Promise<UserOutcome> {
    const now = new Date()
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, suspendedAt: true } })
      if (!user) {
        throw new ModerationError(`No account with the id "${userId}"`)
      }
      if (user.suspendedAt) {
        return { email: user.email, changed: false, shortCodes: [] }
      }

      await tx.user.update({ where: { id: userId }, data: { suspendedAt: now }, select: { id: true } })
      await tx.session.deleteMany({ where: { userId } })
      const rows = await tx.$queryRaw<{ shortCode: string }[]>`
        UPDATE "urls"
        SET "disabledAt" = ${now}, "disabledReason" = 'ACCOUNT_SUSPENDED'::"UrlDisabledReason", "updatedAt" = ${now}
        WHERE "userId" = ${userId}::uuid AND "disabledAt" IS NULL
        RETURNING "shortCode"`
      return { email: user.email, changed: true, shortCodes: rows.map((row) => row.shortCode) }
    })

    if (result.changed) {
      await evictUrls(this.redis, result.shortCodes, this.logger)
      this.logger.log(`User ${userId} suspended; ${result.shortCodes.length} link(s) disabled`)
      this.mail.sendAccountSuspended(result.email)
    }
    return { userId, ...result }
  }

  /** Lifts a suspension and re-enables only the links the suspension disabled. */
  async unsuspendUser(userId: string): Promise<UserOutcome> {
    const now = new Date()
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, suspendedAt: true } })
      if (!user) {
        throw new ModerationError(`No account with the id "${userId}"`)
      }
      if (!user.suspendedAt) {
        return { email: user.email, changed: false, shortCodes: [] }
      }

      await tx.user.update({ where: { id: userId }, data: { suspendedAt: null }, select: { id: true } })
      const rows = await tx.$queryRaw<{ shortCode: string }[]>`
        UPDATE "urls"
        SET "disabledAt" = NULL, "disabledReason" = NULL, "updatedAt" = ${now}
        WHERE "userId" = ${userId}::uuid AND "disabledReason" = 'ACCOUNT_SUSPENDED'::"UrlDisabledReason"
        RETURNING "shortCode"`
      return { email: user.email, changed: true, shortCodes: rows.map((row) => row.shortCode) }
    })

    if (result.changed) {
      await evictUrls(this.redis, result.shortCodes, this.logger)
      this.logger.log(`User ${userId} restored; ${result.shortCodes.length} link(s) re-enabled`)
      this.mail.sendAccountRestored(result.email)
    }
    return { userId, ...result }
  }

  private async findLink(shortCode: string) {
    const url = await this.prisma.url.findUnique({
      where: { shortCode },
      select: { disabledAt: true, disabledReason: true, user: { select: { email: true, suspendedAt: true } } },
    })
    if (!url) {
      throw new ModerationError(`No link with the short code "${shortCode}"`)
    }
    return url
  }

  private shortUrl(shortCode: string): string {
    return `${this.baseUrl}/${shortCode}`
  }
}
