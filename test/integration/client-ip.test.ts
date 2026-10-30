import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { nextIp, PASSWORD, uniqueEmail } from './helpers/auth'
import { startApp, type TestApp } from './helpers/app'

const SECRET = 'front-proxy-secret-for-integration-tests'
// Vercel's egress address as nginx appends it.
const FRONT_EGRESS = '76.76.21.21'

let t: TestApp

beforeAll(async () => {
  t = await startApp()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await t.reset()
})

function login(headers: Record<string, string>) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers,
    payload: { email: 'nobody@example.com', password: PASSWORD },
  })
}

async function statuses(count: number, headers: () => Record<string, string>): Promise<number[]> {
  const result: number[] = []
  for (let n = 0; n < count; n += 1) {
    result.push((await login(headers())).statusCode)
  }
  return result
}

describe('client IP behind the front', () => {
  it('gives each browser behind the front its own rate-limit bucket', async () => {
    const egress = nextIp()
    const results = await statuses(15, () => ({
      'x-forwarded-for': egress,
      'x-proxy-secret': SECRET,
      'x-client-ip': nextIp(),
    }))
    expect(results.every((status) => status === 401)).toBe(true)
  })

  it('throttles one browser behind the front on its own IP', async () => {
    const browser = nextIp()
    const results = await statuses(11, () => ({
      'x-forwarded-for': nextIp(),
      'x-proxy-secret': SECRET,
      'x-client-ip': browser,
    }))
    expect(results[10]).toBe(429)
  })

  it('ignores x-client-ip without the right secret', async () => {
    const egress = nextIp()
    const results = await statuses(11, () => ({
      'x-forwarded-for': egress,
      'x-proxy-secret': 'wrong-secret-wrong-secret-wrong-secret',
      'x-client-ip': nextIp(),
    }))
    expect(results[10]).toBe(429)
  })

  it('records the browser IP on the session', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': FRONT_EGRESS, 'x-proxy-secret': SECRET, 'x-client-ip': '203.0.113.77' },
      payload: { email: uniqueEmail(), password: PASSWORD, acceptTerms: true },
    })

    expect(response.statusCode).toBe(201)
    expect((await t.prisma.session.findFirstOrThrow()).ipAddress).toBe('203.0.113.77')
  })
})
