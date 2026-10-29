import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { Redis } from 'ioredis'

import { createApp } from '@/app.factory'
import { PrismaService } from '@/database/prisma.service'
import { REDIS } from '@/redis/redis.constants'

export interface TestApp {
  app: NestFastifyApplication
  prisma: PrismaService
  /** The app's Redis client; every key it touches carries the test prefix. */
  redis: Redis
  /** Empties every table and every Redis key under the test prefix. */
  reset(): Promise<void>
  close(): Promise<void>
}

/** Boots the application exactly as `main.ts` does, without binding a port. */
export async function startApp(): Promise<TestApp> {
  const app = await createApp()
  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  const prisma = app.get(PrismaService)
  const redis = app.get<Redis>(REDIS)
  const prefix = redis.options.keyPrefix ?? ''
  const unprefixed = redis.duplicate({ keyPrefix: '' })

  return {
    app,
    prisma,
    redis,
    async reset() {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "urls", "sessions", "users" CASCADE')
      const keys = await unprefixed.keys(`${prefix}*`)
      if (keys.length > 0) await unprefixed.del(...keys)
    },
    async close() {
      await unprefixed.quit()
      await app.close()
    },
  }
}
