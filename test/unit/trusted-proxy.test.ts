import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { clientIp, createClientIpResolver, trustProxy } from '@/common/trusted-proxy'

const SECRET = 'front-proxy-secret-0123456789abcdef'

function request(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    socket: { remoteAddress },
    connection: { remoteAddress },
    headers,
  } as unknown as IncomingMessage
}

describe('trustProxy (TRUSTED_PROXY=private)', () => {
  it.each(['127.0.0.1', '::1', '10.0.0.5', '172.20.0.5', '192.168.1.10', 'fd00::1'])('trusts %s', (address) => {
    expect(trustProxy(address, 0)).toBe(true)
  })

  it.each(['203.0.113.9', '8.8.8.8', '2001:db8::1'])('does not trust %s', (address) => {
    expect(trustProxy(address, 0)).toBe(false)
  })
})

describe('clientIp', () => {
  it('takes the forwarded address from a trusted proxy', () => {
    expect(clientIp(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('stops at the first untrusted hop', () => {
    expect(clientIp(request('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 10.0.0.2' }))).toBe('203.0.113.9')
  })

  it('ignores the header from an untrusted peer', () => {
    expect(clientIp(request('203.0.113.50', { 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.50')
  })
})

describe('createClientIpResolver with FRONT_PROXY_SECRET', () => {
  const resolve = createClientIpResolver({ TRUSTED_PROXY: 'private', FRONT_PROXY_SECRET: SECRET })
  // The front reaches nginx from an untrusted address, which nginx appends.
  const viaFront = (headers: Record<string, string>) =>
    request('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 76.76.21.21', ...headers })

  it('takes x-client-ip from a request carrying the secret', () => {
    expect(resolve(viaFront({ 'x-proxy-secret': SECRET, 'x-client-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(resolve(viaFront({ 'x-proxy-secret': SECRET, 'x-client-ip': '2001:db8::7' }))).toBe('2001:db8::7')
  })

  it('falls back to X-Forwarded-For on a wrong or missing secret', () => {
    expect(resolve(viaFront({ 'x-proxy-secret': `${SECRET}x`, 'x-client-ip': '203.0.113.9' }))).toBe('76.76.21.21')
    expect(resolve(viaFront({ 'x-client-ip': '203.0.113.9' }))).toBe('76.76.21.21')
  })

  it.each(['', 'not-an-ip', '203.0.113.9, 1.1.1.1', '999.1.1.1'])('ignores x-client-ip "%s"', (value) => {
    expect(resolve(viaFront({ 'x-proxy-secret': SECRET, 'x-client-ip': value }))).toBe('76.76.21.21')
  })

  it('ignores the headers when no secret is configured', () => {
    const withoutSecret = createClientIpResolver({ TRUSTED_PROXY: 'private', FRONT_PROXY_SECRET: undefined })
    expect(withoutSecret(viaFront({ 'x-proxy-secret': SECRET, 'x-client-ip': '203.0.113.9' }))).toBe('76.76.21.21')
  })

  it('honours TRUSTED_PROXY for the fallback', () => {
    const none = createClientIpResolver({ TRUSTED_PROXY: 'none', FRONT_PROXY_SECRET: SECRET })
    expect(none(viaFront({}))).toBe('127.0.0.1')
    const all = createClientIpResolver({ TRUSTED_PROXY: 'all', FRONT_PROXY_SECRET: SECRET })
    expect(all(viaFront({}))).toBe('1.1.1.1')
  })
})
