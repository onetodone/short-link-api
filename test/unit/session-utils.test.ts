import { describe, expect, it } from 'vitest'

import { parseDurationSeconds } from '@/common/duration.util'
import { hashSessionSecret, verifySessionSecret } from '@/common/session-hash.util'
import { encodeSessionToken, generateSessionSecret, parseSessionToken } from '@/common/session-token.util'

describe('session tokens', () => {
  it('generates distinct base64url secrets', async () => {
    const [a, b] = await Promise.all([generateSessionSecret(), generateSessionSecret()])
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('round-trips through encode and parse', async () => {
    const secret = await generateSessionSecret()
    expect(parseSessionToken(encodeSessionToken('session-id', secret))).toEqual({ sessionId: 'session-id', secret })
  })

  it.each(['', 'no-separator', '.secret', 'id.', 'a.b.c'])('rejects "%s"', (raw) => {
    expect(parseSessionToken(raw)).toBeNull()
  })
})

describe('session secret hashing', () => {
  it('verifies the matching secret only', () => {
    const stored = hashSessionSecret('secret')
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(verifySessionSecret('secret', stored)).toBe(true)
    expect(verifySessionSecret('other', stored)).toBe(false)
  })

  it('rejects a malformed stored hash', () => {
    expect(verifySessionSecret('secret', 'abc')).toBe(false)
  })
})

describe('parseDurationSeconds', () => {
  it.each([
    ['45', 45],
    ['45s', 45],
    ['15m', 900],
    ['2h', 7200],
    ['7d', 604_800],
    [' 3 m ', 180],
  ])('parses "%s" as %i seconds', (value, seconds) => {
    expect(parseDurationSeconds(value, -1)).toBe(seconds)
  })

  it.each(['', '1w', '-5m', '1.5h', 'soon'])('falls back on "%s"', (value) => {
    expect(parseDurationSeconds(value, 42)).toBe(42)
  })
})
