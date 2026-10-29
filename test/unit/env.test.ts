import { describe, expect, it } from 'vitest'

import { validateEnv } from '@/config/env'

const REQUIRED = {
  CORS_ORIGIN: '*',
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SECRET: 'sixteen-chars-ok',
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
      THROTTLE_LIMIT: 100,
    })
  })

  it('coerces numbers and booleans and trims the API prefix', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '3600', REDIS_TLS: 'true', API_PREFIX: '/api/v2/' })
    expect(env.PORT).toBe(3600)
    expect(env.REDIS_TLS).toBe(true)
    expect(env.API_PREFIX).toBe('api/v2')
  })

  it.each(['CORS_ORIGIN', 'DATABASE_URL', 'JWT_SECRET'] as const)('requires %s', (key) => {
    const { [key]: _omitted, ...rest } = REQUIRED
    expect(() => validateEnv(rest)).toThrow(key)
  })

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
})
