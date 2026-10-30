import { registerAs } from '@nestjs/config'

import { env } from '@/config/env'

export const authConfig = registerAs('auth', () => ({
  sessionCleanupIntervalMs: env.SESSION_CLEANUP_INTERVAL_MS,
  turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || undefined,
  turnstileSecretKey: env.TURNSTILE_SECRET_KEY?.trim() || undefined,
}))
