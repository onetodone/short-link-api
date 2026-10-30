import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Redis } from 'ioredis'

import { PrismaService } from '@/database/prisma.service'
import { MetricsService } from '@/modules/metrics/metrics.service'
import { InjectRedis } from '@/redis/redis.constants'
import { ClicksService } from '@/modules/urls/clicks.service'
import { CreateQuotaService } from '@/modules/urls/create-quota.service'
import { destinationRejection, hostnameOf } from '@/modules/urls/destination-rules'
import { evictUrls, urlCacheKey } from '@/modules/urls/url-cache'
import { DestinationRejectedException } from '@/modules/urls/urls.errors'
import { CreatedUrl, ListUrlsOptions, NewUrl, UrlChanges, UrlList, UrlSummary } from '@/modules/urls/urls.types'
import { generateShortCode } from '@/modules/urls/short-code.util'
import { Prisma, UrlDisabledReason } from '@prisma-client'

/** What `UrlsService.resolve` returns, and the cache holds, for a disabled link. */
export const LINK_DISABLED = 'disabled'

const NEGATIVE_SENTINEL = 'not-found'
const LOCK_WAIT_ATTEMPTS = 5
const LOCK_WAIT_INTERVAL_MS = 40

const URL_SUMMARY_SELECT = {
  shortCode: true,
  originalUrl: true,
  note: true,
  clicks: true,
  disabledAt: true,
  disabledReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UrlSelect

type UrlSummaryRow = Prisma.UrlGetPayload<{ select: typeof URL_SUMMARY_SELECT }>

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

@Injectable()
export class UrlsService {
  private readonly logger = new Logger(UrlsService.name)

  private readonly codeLength: number
  private readonly maxRetries: number
  private readonly baseUrl: string
  private readonly ownHostname: string
  private readonly ttlSeconds: number
  private readonly negativeTtlSeconds: number
  private readonly lockTtlMs: number

  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly metrics: MetricsService,
    private readonly clicks: ClicksService,
    private readonly quota: CreateQuotaService,
    config: ConfigService,
  ) {
    this.codeLength = config.get<number>('shortener.codeLength', 7)
    this.maxRetries = config.get<number>('shortener.maxRetries', 5)
    this.baseUrl = config.get<string>('shortener.baseUrl', 'http://localhost:3000')
    this.ownHostname = hostnameOf(this.baseUrl)
    this.ttlSeconds = config.get<number>('cache.ttlSeconds', 3600)
    this.negativeTtlSeconds = config.get<number>('cache.negativeTtlSeconds', 60)
    this.lockTtlMs = config.get<number>('cache.lockTtlMs', 3000)
  }

  async create({ url: originalUrl, note = null }: NewUrl, userId: string | null): Promise<CreatedUrl> {
    this.assertAllowedDestination(originalUrl)
    if (userId !== null) {
      await this.quota.consume(userId)
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const shortCode = await generateShortCode(this.codeLength)

      try {
        const record = await this.prisma.url.create({
          data: { originalUrl, note, shortCode, userId },
          select: { shortCode: true, originalUrl: true, note: true, createdAt: true, updatedAt: true },
        })

        this.metrics.increment('urls_created_total')

        return {
          shortCode: record.shortCode,
          shortUrl: `${this.baseUrl}/${record.shortCode}`,
          originalUrl: record.originalUrl,
          note: record.note,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          this.logger.warn(
            `Short code collision on "${shortCode}" (attempt ${attempt}/${this.maxRetries}), regenerating`,
          )
          continue
        }
        throw error
      }
    }

    this.logger.error(`Exhausted ${this.maxRetries} attempts to allocate a unique short code`)
    throw new ServiceUnavailableException('Could not allocate a unique short code, please retry')
  }

  async listForUser(userId: string, options: ListUrlsOptions): Promise<UrlList> {
    const { limit, offset } = options

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.url.findMany({
        where: { userId },
        select: URL_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.url.count({ where: { userId } }),
    ])

    return {
      items: rows.map((row) => this.toSummary(row)),
      total,
      limit,
      offset,
    }
  }

  async findForUser(userId: string, shortCode: string): Promise<UrlSummary> {
    const record = await this.prisma.url.findUnique({
      where: { shortCode, userId },
      select: URL_SUMMARY_SELECT,
    })
    if (!record) {
      throw new NotFoundException('Short code not found')
    }
    return this.toSummary(record)
  }

  async updateForUser(userId: string, shortCode: string, changes: UrlChanges): Promise<UrlSummary> {
    if (changes.url !== undefined) {
      this.assertAllowedDestination(changes.url)
    }

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        if (changes.url !== undefined) {
          // A new destination clears an unsafe-destination flag; a manual or suspension disable stays.
          await tx.url.updateMany({
            where: {
              shortCode,
              userId,
              disabledReason: UrlDisabledReason.UNSAFE_DESTINATION,
              originalUrl: { not: changes.url },
            },
            data: { disabledAt: null, disabledReason: null },
          })
        }
        return tx.url.update({
          where: { shortCode, userId },
          data: { originalUrl: changes.url, note: changes.note },
          select: URL_SUMMARY_SELECT,
        })
      })

      if (changes.url !== undefined) {
        await this.evictFromCache(shortCode)
      }

      return this.toSummary(record)
    } catch (error) {
      return this.rethrowWriteMiss(error)
    }
  }

  async deleteForUser(userId: string, shortCode: string): Promise<void> {
    try {
      await this.prisma.url.delete({
        where: { shortCode, userId },
        select: { id: true },
      })
    } catch (error) {
      this.rethrowWriteMiss(error)
    }

    await this.evictFromCache(shortCode)
    await this.clicks.discard([shortCode])
  }

  /** Deletes every link owned by `userId` inside `tx` and returns their short codes, for `forget`. */
  async deleteAllForUser(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ shortCode: string }[]>`
      DELETE FROM "urls" WHERE "userId" = ${userId}::uuid RETURNING "shortCode"`
    return rows.map((row) => row.shortCode)
  }

  /** Drops the cached destinations and unflushed clicks of deleted short codes. Never throws. */
  async forget(shortCodes: string[]): Promise<void> {
    await evictUrls(this.redis, shortCodes, this.logger)
    await this.clicks.discard(shortCodes)
  }

  private assertAllowedDestination(url: string): void {
    const reason = destinationRejection(url, this.ownHostname)
    if (reason !== null) {
      throw new DestinationRejectedException(reason)
    }
  }

  private toSummary(row: UrlSummaryRow): UrlSummary {
    return {
      shortCode: row.shortCode,
      shortUrl: `${this.baseUrl}/${row.shortCode}`,
      originalUrl: row.originalUrl,
      note: row.note,
      clicks: row.clicks,
      disabled: row.disabledAt !== null,
      disabledReason: row.disabledReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private rethrowWriteMiss(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundException('Short code not found')
    }
    throw error
  }

  private evictFromCache(shortCode: string): Promise<void> {
    return evictUrls(this.redis, [shortCode], this.logger)
  }

  /**
   * The destination of `shortCode`, or `LINK_DISABLED`. Throws `NotFoundException` for an unknown
   * code. Concurrent misses for one code share a single database read.
   */
  async resolve(shortCode: string): Promise<string> {
    const cached = await this.readCache(shortCode)
    if (cached !== null) {
      this.metrics.increment('cache_hits_total')
      this.logger.debug(`Cache Hit for "${shortCode}"`)
      if (cached === NEGATIVE_SENTINEL) {
        throw new NotFoundException('Short code not found')
      }
      return cached
    }

    this.metrics.increment('cache_misses_total')
    this.logger.debug(`Cache Miss for "${shortCode}"`)

    let task = this.inFlight.get(shortCode)
    if (!task) {
      task = this.fillFromDatabase(shortCode).finally(() => {
        this.inFlight.delete(shortCode)
      })
      this.inFlight.set(shortCode, task)
    }
    return task
  }

  private async readCache(shortCode: string): Promise<string | null> {
    try {
      return await this.redis.get(urlCacheKey(shortCode))
    } catch (error) {
      this.logger.warn(`Redis GET failed for "${shortCode}": ${(error as Error).message}`)
      return null
    }
  }

  private async fillFromDatabase(shortCode: string): Promise<string> {
    const lock = await this.acquireLock(shortCode)

    if (lock === false) {
      const filled = await this.waitForCacheFill(shortCode)
      if (filled !== null) {
        if (filled === NEGATIVE_SENTINEL) {
          throw new NotFoundException('Short code not found')
        }
        return filled
      }
    }

    try {
      const record = await this.prisma.url.findUnique({
        where: { shortCode },
        select: { originalUrl: true, disabledAt: true },
      })

      if (!record) {
        await this.writeCache(urlCacheKey(shortCode), NEGATIVE_SENTINEL, this.negativeTtlSeconds)
        throw new NotFoundException('Short code not found')
      }

      const target = record.disabledAt === null ? record.originalUrl : LINK_DISABLED
      await this.writeCache(urlCacheKey(shortCode), target, this.ttlSeconds)
      return target
    } finally {
      if (lock === true) {
        void this.releaseLock(shortCode)
      }
    }
  }

  private async acquireLock(shortCode: string): Promise<boolean | null> {
    try {
      const result = await this.redis.set(this.lockKey(shortCode), '1', 'PX', this.lockTtlMs, 'NX')
      return result === 'OK'
    } catch {
      return null
    }
  }

  private async releaseLock(shortCode: string): Promise<void> {
    try {
      await this.redis.del(this.lockKey(shortCode))
    } catch (error) {
      this.logger.warn(`Failed to release cache lock for "${shortCode}": ${(error as Error).message}`)
    }
  }

  private async waitForCacheFill(shortCode: string): Promise<string | null> {
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      await delay(LOCK_WAIT_INTERVAL_MS)
      const cached = await this.readCache(shortCode)
      if (cached !== null) {
        return cached
      }
    }
    return null
  }

  private async writeCache(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds)
    } catch (error) {
      this.logger.warn(`Redis SET failed for "${key}": ${(error as Error).message}`)
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  }

  private lockKey(shortCode: string): string {
    return `lock:${shortCode}`
  }
}
