import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MetricsService } from '@/modules/metrics/metrics.service'
import { msUntilRecheck, type DestinationState } from '@/modules/urls/destination-checks.service'
import { SafeBrowsingClient } from '@/modules/urls/safe-browsing.client'

import { safeBrowsingResponse } from '../safe-browsing-double'

const fetchMock = vi.fn<typeof fetch>()

function client(apiKey: string | null = 'key') {
  const config = { get: () => apiKey ?? undefined }
  const metrics = new MetricsService()
  return { client: new SafeBrowsingClient(metrics, config as unknown as ConfigService), metrics }
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

describe('SafeBrowsingClient', () => {
  it('is off without an API key and sends nothing', async () => {
    const { client: off } = client(null)
    expect(off.enabled).toBe(false)
    expect(await off.lookup('https://example.com')).toEqual({ status: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the URL with the API key', async () => {
    fetchMock.mockResolvedValue(safeBrowsingResponse())
    await client().client.lookup('https://example.com/a b')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://safebrowsing.googleapis.com/v5/urls:search?urls=https%3A%2F%2Fexample.com%2Fa+b')
    expect(init?.headers).toEqual({ 'X-Goog-Api-Key': 'key' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('is safe for an empty response', async () => {
    fetchMock.mockResolvedValue(safeBrowsingResponse())
    expect(await client().client.lookup('https://example.com')).toEqual({ status: 'safe' })
  })

  it('decodes the threat types of a match', async () => {
    fetchMock.mockResolvedValue(safeBrowsingResponse('https://evil.example/', [2, 1, 9]))
    const { client: sb, metrics } = client()
    expect(await sb.lookup('https://evil.example/')).toEqual({
      status: 'unsafe',
      threatTypes: ['SOCIAL_ENGINEERING', 'MALWARE', 'THREAT_TYPE_9'],
    })
    expect(counter(metrics, 'safe_browsing_lookups_total')).toBe(1)
    expect(counter(metrics, 'safe_browsing_flagged_total')).toBe(1)
  })

  it.each([
    ['an HTTP error', () => Promise.resolve(new Response('quota', { status: 429 }))],
    ['a network error or timeout', () => Promise.reject(new Error('The operation was aborted due to timeout'))],
    ['a malformed body', () => Promise.resolve(new Response(new Uint8Array([0x0a, 0x50, 0x01])))],
  ])('is unknown on %s', async (_, answer) => {
    fetchMock.mockImplementation(answer)
    const { client: sb, metrics } = client()
    expect(await sb.lookup('https://example.com')).toEqual({ status: 'unknown' })
    expect(counter(metrics, 'safe_browsing_lookup_errors_total')).toBe(1)
  })
})

describe('msUntilRecheck', () => {
  const HOUR = 60 * 60_000
  const now = Date.UTC(2026, 9, 14)

  function state(overrides: Partial<DestinationState>): DestinationState {
    return {
      originalUrl: 'https://example.com',
      destinationSetAt: new Date(now - 30 * 24 * HOUR),
      destinationCheckedAt: new Date(now - HOUR),
      ...overrides,
    }
  }

  it('is due at once for a destination that was never checked', () => {
    expect(msUntilRecheck(state({ destinationCheckedAt: null }), now)).toBe(0)
  })

  it('is hourly in the first week after the destination was set', () => {
    const fresh = { destinationSetAt: new Date(now - 2 * 24 * HOUR) }
    expect(msUntilRecheck(state({ ...fresh, destinationCheckedAt: new Date(now - HOUR + 1000) }), now)).toBe(1000)
    expect(msUntilRecheck(state({ ...fresh, destinationCheckedAt: new Date(now - HOUR) }), now)).toBe(0)
  })

  it('is daily after the first week', () => {
    expect(msUntilRecheck(state({ destinationCheckedAt: new Date(now - 23 * HOUR) }), now)).toBe(HOUR)
    expect(msUntilRecheck(state({ destinationCheckedAt: new Date(now - 25 * HOUR) }), now)).toBe(0)
  })
})
