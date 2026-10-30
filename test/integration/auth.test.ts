import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bearer, nextIp, PASSWORD, refreshCookie, register, uniqueEmail } from './helpers/auth'
import { startApp, type TestApp } from './helpers/app'

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

function refresh(token: string, ip = nextIp()) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { 'x-forwarded-for': ip },
    cookies: { refresh_token: token },
  })
}

describe('POST /api/v1/auth/register', () => {
  it('creates the account, returns an access token and sets the refresh cookie', async () => {
    const ip = nextIp()
    const before = Date.now()
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': ip, 'user-agent': 'vitest' },
      payload: { email: ' New@Example.COM ', password: PASSWORD, acceptTerms: true },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<Record<string, unknown>>()
    expect(body).toEqual({
      user: { id: expect.any(String), email: 'new@example.com', emailVerified: false },
      accessToken: expect.any(String),
    })
    expect(body).not.toHaveProperty('refreshToken')

    const cookie = response.cookies.find((c) => c.name === 'refresh_token')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth', maxAge: 604_800 })

    const session = await t.prisma.session.findFirstOrThrow()
    expect(session).toMatchObject({ ipAddress: ip, userAgent: 'vitest', generation: 0 })

    const { termsAcceptedAt } = await t.prisma.user.findFirstOrThrow()
    expect(termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(termsAcceptedAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('rejects a taken email regardless of letter case', async () => {
    await register(t.app, 'taken@example.com')
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: 'TAKEN@example.com', password: PASSWORD, acceptTerms: true },
    })
    expect(response.statusCode).toBe(409)
  })

  it('rejects an invalid body with field errors', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: 'nope', password: 'short' },
    })
    expect(response.statusCode).toBe(400)
    const paths = response.json<{ errors: { path: string[] }[] }>().errors.map((issue) => issue.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'acceptTerms']))
  })

  it.each([
    ['missing', {}],
    ['declined', { acceptTerms: false }],
  ])('refuses an account when the terms are %s', async (_case, terms) => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: uniqueEmail(), password: PASSWORD, ...terms },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      errors: [{ path: ['acceptTerms'], message: 'You must accept the Terms of Use' }],
    })
    expect(await t.prisma.user.count()).toBe(0)
  })
})

describe('POST /api/v1/auth/login', () => {
  it('signs in with the right password', async () => {
    const { email } = await register(t.app)
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: email.toUpperCase(), password: PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    expect(refreshCookie(response)).toBeDefined()
  })

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { email } = await register(t.app)
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email, password: 'wrong password' },
    })
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: uniqueEmail(), password: PASSWORD },
    })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json<{ message: string }>().message).toBe(unknown.json<{ message: string }>().message)
  })

  it('throttles credential attempts per client IP', async () => {
    const ip = nextIp()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email: 'nobody@example.com', password: PASSWORD },
      })
      statuses.push(response.statusCode)
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true)
    expect(statuses[10]).toBe(429)

    const otherClient = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: 'nobody@example.com', password: PASSWORD },
    })
    expect(otherClient.statusCode).toBe(401)
  })
})

describe('GET /api/v1/auth/me', () => {
  it('returns the profile for a valid access token', async () => {
    const session = await register(t.app)
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: session.userId,
      email: session.email,
      emailVerified: true,
      createdAt: expect.any(String),
    })
  })

  it.each([undefined, 'Bearer not-a-jwt', 'Basic abc'])('rejects authorization %s', async (authorization) => {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authorization ? { authorization } : {},
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the session in place', async () => {
    const session = await register(t.app)
    const response = await refresh(session.refreshToken)

    expect(response.statusCode).toBe(200)
    const rotated = refreshCookie(response)
    expect(rotated).toBeDefined()
    expect(rotated).not.toBe(session.refreshToken)
    expect(rotated?.split('.')[0]).toBe(session.refreshToken.split('.')[0])

    const row = await t.prisma.session.findFirstOrThrow()
    expect(row.generation).toBe(1)
  })

  it('converges concurrent refreshes on one rotation', async () => {
    const session = await register(t.app)
    const responses = await Promise.all(Array.from({ length: 5 }, () => refresh(session.refreshToken)))

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200])
    expect(new Set(responses.map(refreshCookie)).size).toBe(1)
    expect((await t.prisma.session.findFirstOrThrow()).generation).toBe(1)
  })

  it('accepts the retired token inside the grace window', async () => {
    const session = await register(t.app)
    const first = await refresh(session.refreshToken)
    const replay = await refresh(session.refreshToken)

    expect(replay.statusCode).toBe(200)
    expect(refreshCookie(replay)).toBe(refreshCookie(first))
  })

  it('revokes the whole session when the retired token is replayed after the grace window', async () => {
    const session = await register(t.app)
    const rotated = refreshCookie(await refresh(session.refreshToken))
    await t.prisma.session.updateMany({ data: { rotatedAt: new Date(Date.now() - 31_000) } })

    expect((await refresh(session.refreshToken)).statusCode).toBe(401)
    expect(await t.prisma.session.count()).toBe(0)
    expect((await refresh(rotated ?? '')).statusCode).toBe(401)
  })

  it('rejects a missing, malformed, unknown or expired token', async () => {
    const session = await register(t.app)
    const [sessionId] = session.refreshToken.split('.')

    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'x-forwarded-for': nextIp() },
    })
    expect(missing.statusCode).toBe(401)
    expect((await refresh('malformed')).statusCode).toBe(401)
    expect((await refresh(`${sessionId}.wrong-secret`)).statusCode).toBe(401)

    await t.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await refresh(session.refreshToken)).statusCode).toBe(401)
    expect(await t.prisma.session.count()).toBe(0)
  })
})

describe('logout', () => {
  it('revokes the current session only', async () => {
    const { email } = await register(t.app)
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email, password: PASSWORD },
    })
    const otherToken = refreshCookie(other) ?? ''
    const current = await refresh(otherToken)
    const accessToken = current.json<{ accessToken: string }>().accessToken

    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(response.statusCode).toBe(204)
    expect(response.cookies.find((c) => c.name === 'refresh_token')?.value).toBe('')
    expect(await t.prisma.session.count()).toBe(1)
    expect((await refresh(refreshCookie(current) ?? '')).statusCode).toBe(401)
  })

  it('logout-all revokes every session of the user', async () => {
    const session = await register(t.app)
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: session.email, password: PASSWORD },
    })
    const bystander = await register(t.app)

    const response = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: bearer(session) })

    expect(response.statusCode).toBe(204)
    expect(await t.prisma.session.count({ where: { userId: session.userId } })).toBe(0)
    expect(await t.prisma.session.count({ where: { userId: bystander.userId } })).toBe(1)
  })

  it('requires an access token', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout-all' })).statusCode).toBe(401)
  })
})
