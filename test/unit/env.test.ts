import { describe, expect, it } from 'vitest'

import { validateEnv } from '@/config/env'

const REQUIRED = {
  CORS_ORIGIN: '*',
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SECRET: 'sixteen-chars-ok',
  APP_URL: 'https://app.example.com',
  SUPPORT_EMAIL: 'support@example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_FROM_EMAIL: 'noreply@example.com',
}

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv(REQUIRED)
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3000,
      API_PREFIX: 'api/v1',
      TRUSTED_PROXY: 'private',
      REDIS_TLS: false,
      SHORT_CODE_LENGTH: 7,
      REDIRECT_STATUS: 302,
      URL_CREATE_DAILY_LIMIT: 10,
      THROTTLE_LIMIT: 100,
    })
  })

  it('coerces numbers and booleans and trims the API prefix', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '3600', REDIS_TLS: 'true', API_PREFIX: '/api/v2/' })
    expect(env.PORT).toBe(3600)
    expect(env.REDIS_TLS).toBe(true)
    expect(env.API_PREFIX).toBe('api/v2')
  })

  it.each(['CORS_ORIGIN', 'DATABASE_URL', 'JWT_SECRET', 'APP_URL', 'SUPPORT_EMAIL', 'SMTP_HOST', 'SMTP_PORT'] as const)(
    'requires %s',
    (key) => {
      const { [key]: _omitted, ...rest } = REQUIRED
      expect(() => validateEnv(rest)).toThrow(key)
    },
  )

  it('rejects a short JWT secret', () => {
    expect(() => validateEnv({ ...REQUIRED, JWT_SECRET: 'short' })).toThrow('at least 16 characters')
  })

  it('treats an empty FRONT_PROXY_SECRET as unset and rejects a short one', () => {
    expect(validateEnv({ ...REQUIRED, FRONT_PROXY_SECRET: '' }).FRONT_PROXY_SECRET).toBeUndefined()
    expect(validateEnv({ ...REQUIRED, FRONT_PROXY_SECRET: 'x'.repeat(32) }).FRONT_PROXY_SECRET).toBe('x'.repeat(32))
    expect(() => validateEnv({ ...REQUIRED, FRONT_PROXY_SECRET: 'too-short' })).toThrow('FRONT_PROXY_SECRET')
  })

  it('accepts only known TRUSTED_PROXY modes', () => {
    for (const mode of ['private', 'all', 'none']) {
      expect(validateEnv({ ...REQUIRED, TRUSTED_PROXY: mode }).TRUSTED_PROXY).toBe(mode)
    }
    expect(() => validateEnv({ ...REQUIRED, TRUSTED_PROXY: 'loopback' })).toThrow('TRUSTED_PROXY')
  })

  it('accepts only 301 and 302 as REDIRECT_STATUS', () => {
    expect(validateEnv({ ...REQUIRED, REDIRECT_STATUS: '301' }).REDIRECT_STATUS).toBe(301)
    expect(validateEnv({ ...REQUIRED, REDIRECT_STATUS: '302' }).REDIRECT_STATUS).toBe(302)
    expect(() => validateEnv({ ...REQUIRED, REDIRECT_STATUS: '307' })).toThrow('REDIRECT_STATUS')
  })

  it('takes the sender from SMTP_FROM_EMAIL or SMTP_USER and requires one of them', () => {
    const { SMTP_FROM_EMAIL: _omitted, ...rest } = REQUIRED
    expect(validateEnv({ ...rest, SMTP_USER: 'mailer@example.com' }).SMTP_USER).toBe('mailer@example.com')
    expect(() => validateEnv(rest)).toThrow('SMTP_FROM_EMAIL or SMTP_USER must be set')
    expect(() => validateEnv({ ...REQUIRED, SMTP_FROM_EMAIL: 'not-an-email' })).toThrow('SMTP_FROM_EMAIL')
  })

  it('reads SMTP_SECURE and SMTP_REQUIRE_TLS as true, false or unset', () => {
    expect(validateEnv({ ...REQUIRED, SMTP_SECURE: '1', SMTP_REQUIRE_TLS: 'false' })).toMatchObject({
      SMTP_SECURE: true,
      SMTP_REQUIRE_TLS: false,
    })
    expect(validateEnv({ ...REQUIRED, SMTP_SECURE: '' }).SMTP_SECURE).toBeUndefined()
    expect(() => validateEnv({ ...REQUIRED, SMTP_SECURE: 'yes' })).toThrow('SMTP_SECURE')
  })

  it('accepts only an http(s) APP_URL and drops its trailing slash', () => {
    expect(validateEnv({ ...REQUIRED, APP_URL: 'https://app.example.com/' }).APP_URL).toBe('https://app.example.com')
    expect(() => validateEnv({ ...REQUIRED, APP_URL: 'ftp://app.example.com' })).toThrow('APP_URL')
  })
})
