import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Redis } from 'ioredis'

import { PrismaService } from '@/database/prisma.service'
import { MetricsService } from '@/modules/metrics/metrics.service'
import { InjectRedis } from '@/redis/redis.constants'

const COUNTER_PREFIX = 'clicks:'
const DIRTY_SET = 'clicks:dirty'

interface ClickDelta {
  shortCode: string
  delta: number
}

@Injectable()
export class ClicksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClicksService.name)
  private readonly flushIntervalMs: number

  private timer: NodeJS.Timeout | null = null
  private flushing = false

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.flushIntervalMs = config.get<number>('cache.clicksFlushIntervalMs', 5000)
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
    this.timer.unref()
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  increment(shortCode: string): void {
    this.redis
      .multi()
      .incr(`${COUNTER_PREFIX}${shortCode}`)
      .sadd(DIRTY_SET, shortCode)
      .exec()
      .catch((error: unknown) => {
        this.logger.warn(`Failed to buffer click for "${shortCode}": ${(error as Error).message}`)
      })
  }

  async discard(shortCode: string): Promise<void> {
    try {
      await this.redis.multi().del(`${COUNTER_PREFIX}${shortCode}`).srem(DIRTY_SET, shortCode).exec()
    } catch (error) {
      this.logger.warn(`Failed to discard click buffer for "${shortCode}": ${(error as Error).message}`)
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      return
    }
    this.flushing = true

    try {
      const codes = await this.redis.smembers(DIRTY_SET)
      if (codes.length === 0) {
        return
      }

      const deltas: ClickDelta[] = []
      for (const shortCode of codes) {
        // Clear the dirty flag first: a click landing after it re-adds the code, so it is never stranded.
        await this.redis.srem(DIRTY_SET, shortCode)
        const raw = await this.redis.getdel(`${COUNTER_PREFIX}${shortCode}`)

        const delta = Number(raw ?? 0)
        if (Number.isFinite(delta) && delta > 0) {
          deltas.push({ shortCode, delta })
        }
      }

      if (deltas.length === 0) {
        return
      }

      try {
        await this.prisma.$transaction(
          deltas.map(({ shortCode, delta }) =>
            this.prisma.url.updateMany({
              where: { shortCode },
              data: { clicks: { increment: delta } },
            }),
          ),
        )
        const flushed = deltas.reduce((sum, { delta }) => sum + delta, 0)
        this.metrics.increment('clicks_flushed_total', flushed)
        this.logger.debug(`Flushed ${flushed} click(s) for ${deltas.length} code(s)`)
      } catch (error) {
        this.metrics.increment('clicks_flush_errors_total')
        this.logger.warn(
          `Click flush to Postgres failed, re-buffering ${deltas.length} code(s): ${(error as Error).message}`,
        )
        await this.reBuffer(deltas)
      }
    } catch (error) {
      this.logger.warn(`Click flush aborted: ${(error as Error).message}`)
    } finally {
      this.flushing = false
    }
  }

  private async reBuffer(deltas: ClickDelta[]): Promise<void> {
    for (const { shortCode, delta } of deltas) {
      try {
        await this.redis.multi().incrby(`${COUNTER_PREFIX}${shortCode}`, delta).sadd(DIRTY_SET, shortCode).exec()
      } catch (error) {
        this.logger.error(
          `Failed to re-buffer ${delta} click(s) for "${shortCode}" — counts lost: ${(error as Error).message}`,
        )
      }
    }
  }
}
