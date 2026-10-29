import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { clientIp, trustProxy } from '@/common/trusted-proxy'

function request(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    connection: { remoteAddress },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
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
    expect(clientIp(request('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9')
  })

  it('stops at the first untrusted hop', () => {
    expect(clientIp(request('127.0.0.1', '1.1.1.1, 203.0.113.9, 10.0.0.2'))).toBe('203.0.113.9')
  })

  it('ignores the header from an untrusted peer', () => {
    expect(clientIp(request('203.0.113.50', '1.1.1.1'))).toBe('203.0.113.50')
  })
})
