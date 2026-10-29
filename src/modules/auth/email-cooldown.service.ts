import { Injectable, Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { InjectRedis } from '@/redis/redis.constants'

const COOLDOWN_SECONDS = 60

@Injectable()
export class EmailCooldownService {
  private readonly logger = new Logger(EmailCooldownService.name)

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Starts a cooldown for `subject` and returns `0`, or returns the seconds left of a running one.
   * A Redis failure returns `0`, so an outage never stops account emails.
   */
  async acquire(subject: string): Promise<number> {
    const key = `cooldown:email:${subject}`
    try {
      const results = await this.redis.multi().set(key, 1, 'EX', COOLDOWN_SECONDS, 'NX').ttl(key).exec()
      if (results?.[0]?.[1] === 'OK') return 0
      return Math.max(Number(results?.[1]?.[1]), 1)
    } catch (error) {
      this.logger.warn(`Email cooldown check failed for ${subject}: ${(error as Error).message}`)
      return 0
    }
  }
}
