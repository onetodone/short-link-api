import '@/common/load-env'

import { once } from 'node:events'

import { NestFactory } from '@nestjs/core'
import type { Redis } from 'ioredis'

import { ModerationCliModule } from '@/cli/moderation-cli.module'
import { parseModerationCommand, runModerationCommand } from '@/cli/moderation-commands'
import { ModerationError, ModerationService } from '@/modules/moderation/moderation.service'
import { REDIS } from '@/redis/redis.constants'

const REDIS_READY_TIMEOUT_MS = 10_000

/** The cache must be reachable: a change whose eviction failed would keep redirecting from the cache. */
async function redisReady(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return
  await once(redis, 'ready', { signal: AbortSignal.timeout(REDIS_READY_TIMEOUT_MS) }).catch(() => {
    throw new Error('Redis is not reachable')
  })
}

async function main(): Promise<void> {
  let command
  try {
    command = parseModerationCommand(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
    return
  }

  const app = await NestFactory.createApplicationContext(ModerationCliModule, { logger: ['warn', 'error'] })
  const redis = app.get<Redis>(REDIS)
  try {
    await redisReady(redis)
    const lines = await runModerationCommand(app.get(ModerationService), command)
    process.stdout.write(`${lines.join('\n')}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof ModerationError ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    redis.removeAllListeners('end')
    // Also waits for the owner emails to be handed to SMTP.
    await app.close()
  }
}

void main()
