import { registerAs } from '@nestjs/config'

import { env } from '@/config/env'

export const redisConfig = registerAs('redis', () => ({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB,
  keyPrefix: env.REDIS_KEY_PREFIX,
  tls: env.REDIS_TLS,
}))
