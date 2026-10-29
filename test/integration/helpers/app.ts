import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { MailTransport, OutgoingMessage } from '@onetodone/mailer'
import type { Redis } from 'ioredis'

import { createApp } from '@/app.factory'
import { PrismaService } from '@/database/prisma.service'
import { MAIL_TRANSPORT } from '@/mail/mail.constants'
import { REDIS } from '@/redis/redis.constants'

/** Headers of a desktop browser, so a redirect counts as a click (`inject()`'s own User-Agent is a bot). */
export const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

export interface TestApp {
  app: NestFastifyApplication
  prisma: PrismaService
  /** The app's Redis client; every key it touches carries the test prefix. */
  redis: Redis
  /** Every email the app handed to its transport, oldest first. Nothing reaches SMTP. */
  mail: OutgoingMessage[]
  /** Empties every table, every Redis key under the test prefix and the recorded emails. */
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

  const mail: OutgoingMessage[] = []
  const transport = app.get<MailTransport>(MAIL_TRANSPORT)
  transport.send = (message) => {
    mail.push(message)
    return Promise.resolve({ messageId: `test-${mail.length}` })
  }

  return {
    app,
    prisma,
    redis,
    mail,
    async reset() {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "urls", "verification_tokens", "sessions", "users" CASCADE')
      const keys = await unprefixed.keys(`${prefix}*`)
      if (keys.length > 0) await unprefixed.del(...keys)
      mail.length = 0
    },
    async close() {
      await unprefixed.quit()
      await app.close()
    },
  }
}
