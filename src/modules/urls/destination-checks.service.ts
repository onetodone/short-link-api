import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { PrismaService } from '@/database/prisma.service'
import { ModerationError, ModerationService } from '@/modules/moderation/moderation.service'
import { SafeBrowsingClient } from '@/modules/urls/safe-browsing.client'
import { InjectRedis } from '@/redis/redis.constants'
import { UrlDisabledReason } from '@prisma-client'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
// Blocklists pick up a fresh phishing domain within hours of a campaign starting, so new
// destinations are re-checked more often than settled ones.
const NEW_DESTINATION_PERIOD_MS = 7 * 24 * HOUR_MS
const NEW_DESTINATION_RECHECK_MS = HOUR_MS
const RECHECK_MS = 24 * HOUR_MS

// Each instance asks Redis about a code at most this often, however busy the link is.
const LOCAL_GATE_MS = 5 * MINUTE_MS
const LOCAL_GATE_MAX_ENTRIES = 50_000
// Covers one database read and one lookup; replaced by the time until the next check is due.
const CLAIM_MS = MINUTE_MS
const MAX_PENDING = 1_000
const CONCURRENCY = 4

/** A link's destination and the state of its Safe Browsing checks. */
export interface DestinationState {
  originalUrl: string
  destinationSetAt: Date
  destinationCheckedAt: Date | null
}

/**
 * Milliseconds until the destination is due for another lookup, `0` when it is due: hourly during
 * the first week after it was set, daily after that, and right away if it was never checked.
 */
export function msUntilRecheck(state: DestinationState, now = Date.now()): number {
  if (state.destinationCheckedAt === null) return 0

  const isNew = now - state.destinationSetAt.getTime() < NEW_DESTINATION_PERIOD_MS
  const dueAt = state.destinationCheckedAt.getTime() + (isNew ? NEW_DESTINATION_RECHECK_MS : RECHECK_MS)
  return Math.max(dueAt - now, 0)
}

export function destinationCheckKey(shortCode: string): string {
  return `sb:${shortCode}`
}

/**
 * Re-checks destinations with Safe Browsing after redirects and disables the links it flags.
 * `schedule` only queues the code in memory, so the redirect never waits on Redis, Postgres or Google.
 */
@Injectable()
export class DestinationChecksService implements OnModuleDestroy {
  private readonly logger = new Logger(DestinationChecksService.name)

  private readonly gatedUntil = new Map<string, number>()
  private readonly pending = new Set<string>()
  private readonly running = new Set<Promise<void>>()
  private closed = false

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly safeBrowsing: SafeBrowsingClient,
    private readonly moderation: ModerationService,
  ) {}

  /** Queues a re-check of `shortCode` if one may be due. Synchronous and never throws. */
  schedule(shortCode: string): void {
    if (!this.safeBrowsing.enabled || this.closed || this.pending.size >= MAX_PENDING) return

    const now = Date.now()
    if ((this.gatedUntil.get(shortCode) ?? 0) > now) return
    if (this.gatedUntil.size >= LOCAL_GATE_MAX_ENTRIES) this.gatedUntil.clear()
    this.gatedUntil.set(shortCode, now + LOCAL_GATE_MS)

    this.pending.add(shortCode)
    this.drain()
  }

  /** Lets the next redirect of `shortCode` re-check it at once, e.g. after its destination changed. */
  async reset(shortCode: string): Promise<void> {
    this.gatedUntil.delete(shortCode)
    try {
      await this.redis.del(destinationCheckKey(shortCode))
    } catch (error) {
      this.logger.warn(`Failed to reset the destination check of "${shortCode}": ${(error as Error).message}`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true
    this.pending.clear()
    await Promise.allSettled([...this.running])
  }

  private drain(): void {
    for (const shortCode of this.pending) {
      if (this.running.size >= CONCURRENCY) return
      this.pending.delete(shortCode)
      const task = this.check(shortCode).finally(() => {
        this.running.delete(task)
        this.drain()
      })
      this.running.add(task)
    }
  }

  private async check(shortCode: string): Promise<void> {
    try {
      const key = destinationCheckKey(shortCode)
      // Across instances, one claim per code until the next check is due.
      if ((await this.redis.set(key, '1', 'PX', CLAIM_MS, 'NX')) !== 'OK') return

      const url = await this.prisma.url.findUnique({
        where: { shortCode },
        select: { originalUrl: true, disabledAt: true, destinationSetAt: true, destinationCheckedAt: true },
      })
      if (!url || url.disabledAt !== null) return

      const wait = msUntilRecheck(url)
      if (wait > 0) {
        await this.redis.pexpire(key, wait)
        return
      }

      // A failed lookup still counts as the check, so an outage doesn't retry on every redirect.
      const checkedAt = new Date()
      const claimed = await this.prisma.url.updateMany({
        where: {
          shortCode,
          originalUrl: url.originalUrl,
          disabledAt: null,
          destinationCheckedAt: url.destinationCheckedAt,
        },
        data: { destinationCheckedAt: checkedAt },
      })
      if (claimed.count === 0) return
      await this.redis.pexpire(key, msUntilRecheck({ ...url, destinationCheckedAt: checkedAt }))

      const verdict = await this.safeBrowsing.lookup(url.originalUrl)
      if (verdict.status !== 'unsafe') return

      const outcome = await this.moderation.disableLink(shortCode, UrlDisabledReason.UNSAFE_DESTINATION, {
        destination: url.originalUrl,
      })
      if (outcome.changed) {
        this.logger.warn(`Link "${shortCode}" flagged by Safe Browsing (${verdict.threatTypes.join(', ')})`)
      }
    } catch (error) {
      if (error instanceof ModerationError) return // the link was deleted during the check
      this.logger.error(`Destination check of "${shortCode}" failed: ${(error as Error).message}`)
    }
  }
}
