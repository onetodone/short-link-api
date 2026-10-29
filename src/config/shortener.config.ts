import { registerAs } from '@nestjs/config'

import { env } from '@/config/env'

export const shortenerConfig = registerAs('shortener', () => ({
  baseUrl: (env.SHORT_URL_BASE ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
  codeLength: env.SHORT_CODE_LENGTH,
  maxRetries: env.SHORT_CODE_MAX_RETRIES,
  redirectStatus: env.REDIRECT_STATUS,
  createDailyLimit: env.URL_CREATE_DAILY_LIMIT,
}))
