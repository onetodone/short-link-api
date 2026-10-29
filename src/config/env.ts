import '@/common/load-env'

import { z } from 'zod'

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).default(3000),
  API_PREFIX: z
    .string()
    .default('api/v1')
    .transform((value) => value.replace(/^\/+|\/+$/g, '')),

  CORS_ORIGIN: z.string().min(1),
  COOKIE_SECRET: z.string().optional(),
  TRUSTED_PROXY: z.enum(['private', 'all', 'none']).default('private'),
  FRONT_PROXY_SECRET: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.string().min(32, 'FRONT_PROXY_SECRET must be at least 32 characters').optional()),

  DATABASE_URL: z.string().min(1),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('shortlink:'),
  REDIS_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().min(0).default(200),

  THROTTLE_TTL: z.coerce.number().int().min(1).default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(100),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('7d'),

  SESSION_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),

  SHORT_URL_BASE: z.string().url().optional(),
  SHORT_CODE_LENGTH: z.coerce.number().int().min(4).max(32).default(7),
  SHORT_CODE_MAX_RETRIES: z.coerce.number().int().min(1).default(5),

  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
  CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  CACHE_LOCK_TTL_MS: z.coerce.number().int().min(1).default(3000),
  CLICKS_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),

  npm_package_version: z.string().default('0.0.0'),
})

type EnvVars = z.infer<typeof envSchema>

export type Env = Readonly<EnvVars>

function parseEnv(source: Record<string, unknown>): EnvVars {
  const result = envSchema.safeParse(source)

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Environment validation failed:\n${details}`)
  }

  return result.data
}

export function validateEnv(config: Record<string, unknown>): EnvVars {
  return parseEnv(config)
}

let cached: Env | undefined

export function getEnv(): Env {
  cached ??= Object.freeze(parseEnv(process.env))
  return cached
}

export const env = getEnv()
