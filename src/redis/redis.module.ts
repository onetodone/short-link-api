import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'

import { REDIS } from '@/redis/redis.constants'

function createRedisClient(config: ConfigService): Redis {
  const logger = new Logger('RedisClient')

  const host = config.get<string>('redis.host', 'localhost')
  const port = config.get<number>('redis.port', 6379)
  const tlsEnabled = config.get<boolean>('redis.tls', false)

  const options: RedisOptions = {
    host,
    port,
    password: config.get<string>('redis.password') || undefined,
    db: config.get<number>('redis.db', 0),
    keyPrefix: config.get<string>('redis.keyPrefix', 'shortlink:'),
    tls: tlsEnabled ? {} : undefined,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
    reconnectOnError: (err: Error) => err.message.includes('READONLY'),
  }

  const client = new Redis(options)

  let outageReported = false
  client.on('ready', () => {
    outageReported = false
    logger.log(`Connected to Redis at ${host}:${port}`)
  })
  client.on('reconnecting', (delayMs: number) => {
    if (!outageReported) {
      logger.warn(`Reconnecting to Redis in ${delayMs}ms`)
    }
  })
  client.on('end', () => logger.warn('Redis connection closed'))
  client.on('error', (err: Error) => {
    if (outageReported) {
      logger.debug(`Redis error: ${err.message}`)
      return
    }
    outageReported = true
    logger.error(`Redis error: ${err.message}`)
  })

  return client
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: createRedisClient,
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name)

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'end') {
      return
    }

    try {
      await this.redis.quit()
      this.logger.log('Redis connection closed gracefully')
    } catch (error) {
      this.logger.error(`Failed to close Redis gracefully: ${(error as Error).message}`)
      this.redis.disconnect()
    }
  }
}
