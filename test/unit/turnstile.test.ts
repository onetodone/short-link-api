import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TurnstileClient } from '@/modules/auth/turnstile.client'
import { MetricsService } from '@/modules/metrics/metrics.service'

const fetchMock = vi.fn<typeof fetch>()

function client(keys: { siteKey?: string; secretKey?: string } = { siteKey: 'site-key', secretKey: 'secret-key' }) {
  const values: Record<string, string | undefined> = {
    'auth.turnstileSiteKey': keys.siteKey,
    'auth.turnstileSecretKey': keys.secretKey,
  }
  const config = { get: (key: string) => values[key] }
  const metrics = new MetricsService()
  return { client: new TurnstileClient(metrics, config as unknown as ConfigService), metrics }
}

function counter(metrics: MetricsService, name: string): number {
  return Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(metrics.render())?.[1])
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('TurnstileClient', () => {
  it('is on only with both keys', () => {
    expect(client().client).toMatchObject({ enabled: true, siteKey: 'site-key' })
    expect(client({ siteKey: 'site-key' }).client).toMatchObject({ enabled: false, siteKey: null })
    expect(client({ secretKey: 'secret-key' }).client).toMatchObject({ enabled: false, siteKey: null })
  })

  it('passes everything and sends nothing when off', async () => {
    expect(await client({}).client.verify('token', 'login', '203.0.113.7')).toBe('ok')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the secret, the token and a known IP', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ success: true, action: 'register' })))
    const { client: turnstile, metrics } = client()

    expect(await turnstile.verify('token', 'register', '203.0.113.7')).toBe('ok')
    expect(Object.fromEntries(fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams)).toEqual({
      secret: 'secret-key',
      response: 'token',
      remoteip: '203.0.113.7',
    })

    expect(await turnstile.verify('token', 'register', undefined)).toBe('ok')
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).has('remoteip')).toBe(false)
    expect(counter(metrics, 'captcha_checks_total')).toBe(2)
  })

  it('fails a token issued for another form', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, action: 'register' }))
    const { client: turnstile, metrics } = client()
    expect(await turnstile.verify('token', 'login', undefined)).toBe('failed')
    expect(counter(metrics, 'captcha_rejected_total')).toBe(1)
  })

  it('accepts the testing keys, which answer without an action', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, metadata: { result_with_testing_key: true } }))
    expect(await client().client.verify('token', 'login', undefined)).toBe('ok')
  })

  it('fails a rejected token', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: false, 'error-codes': ['invalid-input-response'] }))
    expect(await client().client.verify('token', 'login', undefined)).toBe('failed')
  })

  it('is unavailable when Cloudflare errs, times out or answers garbage', async () => {
    const { client: turnstile, metrics } = client()
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }))
    expect(await turnstile.verify('token', 'login', undefined)).toBe('unavailable')
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await turnstile.verify('token', 'login', undefined)).toBe('unavailable')
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    expect(await turnstile.verify('token', 'login', undefined)).toBe('unavailable')
    expect(counter(metrics, 'captcha_errors_total')).toBe(3)
  })
})
