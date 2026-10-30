import type { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'

const EVICT_BATCH = 500

export function urlCacheKey(shortCode: string): string {
  return `url:${shortCode}`
}

/** Drops the cached resolutions of `shortCodes`, so the next redirect reads Postgres. Never throws. */
export async function evictUrls(redis: Redis, shortCodes: readonly string[], logger: Logger): Promise<void> {
  for (let start = 0; start < shortCodes.length; start += EVICT_BATCH) {
    const keys = shortCodes.slice(start, start + EVICT_BATCH).map(urlCacheKey)
    try {
      await redis.del(...keys)
    } catch (error) {
      logger.warn(`Failed to evict cache for ${keys.length} code(s): ${(error as Error).message}`)
    }
  }
}
