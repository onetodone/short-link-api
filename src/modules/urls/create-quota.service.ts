import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Redis } from 'ioredis'

import { CreateQuotaExceededException } from '@/modules/urls/urls.errors'
import { InjectRedis } from '@/redis/redis.constants'

const WINDOW_SECONDS = 24 * 60 * 60

@Injectable()
export class CreateQuotaService {
  private readonly logger = new Logger(CreateQuotaService.name)
  private readonly limit: number

  constructor(
    @InjectRedis() private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.limit = config.get<number>('shortener.createDailyLimit', 10)
  }

  /**
   * Counts one link creation for `userId` and throws `CreateQuotaExceededException` past the limit.
   * The 24 h window opens with the account's first creation in it. A Redis failure lets the creation
   * through.
   */
  async consume(userId: string): Promise<void> {
    if (this.limit === 0) return

    const key = this.key(userId)
    let count: number
    let ttlSeconds: number
    try {
      const results = await this.redis.multi().set(key, 0, 'EX', WINDOW_SECONDS, 'NX').incr(key).ttl(key).exec()
      count = Number(results?.[1]?.[1])
      ttlSeconds = Number(results?.[2]?.[1])
    } catch (error) {
      this.logger.warn(`Create quota check failed for user ${userId}: ${(error as Error).message}`)
      return
    }

    if (count > this.limit) {
      throw new CreateQuotaExceededException(this.limit, Math.max(ttlSeconds, 1))
    }
  }

  async forget(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId))
    } catch (error) {
      this.logger.warn(`Failed to drop create quota of user ${userId}: ${(error as Error).message}`)
    }
  }

  private key(userId: string): string {
    return `quota:create:${userId}`
  }
}
