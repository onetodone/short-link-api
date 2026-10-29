import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BROWSER, startApp, type TestApp } from './helpers/app'
import { bearer, linkToken, nextIp, PASSWORD, refreshCookie, register, type Session, uniqueEmail } from './helpers/auth'

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

function call(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method,
    url: `/api/v1/auth/${url}`,
    headers: { 'x-forwarded-for': nextIp(), ...headers },
    payload,
  })
}

function refresh(token: string) {
  return t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { refresh_token: token } })
}

function login(email: string, password: string) {
  return call('POST', 'login', { email, password })
}

async function createUrl(session: Session): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/urls',
    headers: bearer(session),
    payload: { url: `https://example.com/${Math.random().toString(36).slice(2)}` },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ shortCode: string }>().shortCode
}

/** Waits for an email to `to` whose subject or text matches `pattern`; sending runs in the background. */
async function emailTo(to: string, pattern: RegExp) {
  let found: (typeof t.mail)[number] | undefined
  await vi.waitFor(() => {
    found = t.mail.find((message) => message.to === to && pattern.test(`${message.subject}\n${message.text}`))
    expect(found).toBeDefined()
  })
  return found as (typeof t.mail)[number]
}

describe('PATCH /auth/me/password', () => {
  it('sets the password, keeps the current session, revokes the others and notifies the owner', async () => {
    const session = await register(t.app)
    const other = await login(session.email, PASSWORD)
    const otherCookie = refreshCookie(other) as string

    const response = await call(
      'PATCH',
      'me/password',
      { currentPassword: PASSWORD, newPassword: 'a brand new password' },
      bearer(session),
    )
    expect(response.statusCode).toBe(204)

    expect((await refresh(session.refreshToken)).statusCode).toBe(200)
    expect((await refresh(otherCookie)).statusCode).toBe(401)
    expect((await login(session.email, PASSWORD)).statusCode).toBe(401)
    expect((await login(session.email, 'a brand new password')).statusCode).toBe(200)

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
    expect(user.passwordChangedAt).toBeInstanceOf(Date)
    await emailTo(session.email, /password/i)
  })

  it('refuses a wrong current password with INVALID_PASSWORD and changes nothing', async () => {
    const session = await register(t.app)

    const response = await call(
      'PATCH',
      'me/password',
      { currentPassword: 'not the password', newPassword: 'a brand new password' },
      bearer(session),
    )
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'INVALID_PASSWORD' })
    expect((await login(session.email, PASSWORD)).statusCode).toBe(200)
  })

  it('validates the body and requires a session', async () => {
    const session = await register(t.app)

    const short = await call(
      'PATCH',
      'me/password',
      { currentPassword: PASSWORD, newPassword: 'short' },
      bearer(session),
    )
    expect(short.statusCode).toBe(400)
    expect(
      (await call('PATCH', 'me/password', { currentPassword: PASSWORD, newPassword: 'long enough' })).statusCode,
    ).toBe(401)
  })
})

describe('email change', () => {
  it('confirms the new address with the emailed link and tells the old one', async () => {
    const session = await register(t.app)
    const ip = nextIp()

    const request = await call(
      'POST',
      'me/email',
      { newEmail: ' New@Example.com ', password: PASSWORD },
      { ...bearer(session), 'x-forwarded-for': ip },
    )
    expect(request.statusCode).toBe(204)

    const link = await emailTo('new@example.com', /confirm-email\?token=/)
    expect(link.text).toMatch(/http:\/\/app\.test\/confirm-email\?token=[\w-]+/)
    const notice = await emailTo(session.email, /new@example\.com/)
    expect(notice.text).toContain(ip)

    const unchanged = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
    expect(unchanged.email).toBe(session.email)

    const confirm = await call('POST', 'email/confirm', { token: linkToken(link) })
    expect(confirm.statusCode).toBe(200)
    expect(confirm.json()).toEqual({ user: { id: session.userId, email: 'new@example.com', emailVerified: true } })

    await emailTo(session.email, /changed/i)
    expect((await login('new@example.com', PASSWORD)).statusCode).toBe(200)
    expect((await login(session.email, PASSWORD)).statusCode).toBe(401)
    expect((await refresh(session.refreshToken)).json()).toMatchObject({ user: { email: 'new@example.com' } })

    const again = await call('POST', 'email/confirm', { token: linkToken(link) })
    expect(again.json()).toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('confirms an unconfirmed account and retires its other emailed links', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    const verifyLink = await emailTo(session.email, /verify-email\?token=/)
    await call('POST', 'password/forgot', { email: session.email })
    const resetLink = await emailTo(session.email, /reset-password\?token=/)

    await call('POST', 'me/email', { newEmail: 'fixed@example.com', password: PASSWORD }, bearer(session))
    const link = await emailTo('fixed@example.com', /confirm-email\?token=/)
    const confirm = await call('POST', 'email/confirm', { token: linkToken(link) })
    expect(confirm.json()).toMatchObject({ user: { emailVerified: true } })

    expect((await call('POST', 'verify-email', { token: linkToken(verifyLink) })).statusCode).toBe(400)
    const reset = await call('POST', 'password/reset', { token: linkToken(resetLink), password: 'hijacked password' })
    expect(reset.json()).toMatchObject({ code: 'INVALID_TOKEN' })
    expect(await t.prisma.verificationToken.count()).toBe(0)
  })

  it('answers 409 at confirmation when another account took the address', async () => {
    const session = await register(t.app)
    await call('POST', 'me/email', { newEmail: 'taken@example.com', password: PASSWORD }, bearer(session))
    const link = await emailTo('taken@example.com', /confirm-email\?token=/)
    await register(t.app, 'taken@example.com')

    const confirm = await call('POST', 'email/confirm', { token: linkToken(link) })
    expect(confirm.statusCode).toBe(409)
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
    expect(user.email).toBe(session.email)
  })

  it('refuses a wrong password, the current address and a request inside the cooldown', async () => {
    const session = await register(t.app)

    const wrong = await call('POST', 'me/email', { newEmail: 'a@example.com', password: 'nope' }, bearer(session))
    expect(wrong.json()).toMatchObject({ statusCode: 403, code: 'INVALID_PASSWORD' })

    const same = await call('POST', 'me/email', { newEmail: session.email, password: PASSWORD }, bearer(session))
    expect(same.statusCode).toBe(400)

    expect(
      (await call('POST', 'me/email', { newEmail: 'a@example.com', password: PASSWORD }, bearer(session))).statusCode,
    ).toBe(204)
    const tooSoon = await call('POST', 'me/email', { newEmail: 'b@example.com', password: PASSWORD }, bearer(session))
    expect(tooSoon.statusCode).toBe(429)
    expect(tooSoon.json()).toMatchObject({ code: 'EMAIL_COOLDOWN' })
  })

  it('keeps only the latest pending change', async () => {
    const session = await register(t.app)
    await call('POST', 'me/email', { newEmail: 'first@example.com', password: PASSWORD }, bearer(session))
    const first = await emailTo('first@example.com', /confirm-email\?token=/)
    await t.redis.del(`cooldown:email:change:${session.userId}`)
    await call('POST', 'me/email', { newEmail: 'second@example.com', password: PASSWORD }, bearer(session))
    const second = await emailTo('second@example.com', /confirm-email\?token=/)

    expect((await call('POST', 'email/confirm', { token: linkToken(first) })).statusCode).toBe(400)
    expect((await call('POST', 'email/confirm', { token: linkToken(second) })).statusCode).toBe(200)
  })

  it('rejects tokens issued for another purpose', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    const verifyLink = await emailTo(session.email, /verify-email\?token=/)

    expect((await call('POST', 'email/confirm', { token: linkToken(verifyLink) })).json()).toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })
})

describe('DELETE /auth/me', () => {
  it('deletes the account, its sessions and links, and leaves no cache keys behind', async () => {
    const session = await register(t.app)
    const kept = await register(t.app)
    const codes = [await createUrl(session), await createUrl(session)]
    const keptCode = await createUrl(kept)

    for (const code of [...codes, keptCode]) {
      const redirect = await t.app.inject({ method: 'GET', url: `/${code}`, headers: BROWSER })
      expect(redirect.statusCode).toBe(302)
    }
    await vi.waitFor(async () => expect(await t.redis.exists(`clicks:${codes[0]}`)).toBe(1))
    expect(await t.redis.exists(`url:${codes[0]}`)).toBe(1)

    const response = await call('DELETE', 'me', { password: PASSWORD }, bearer(session))
    expect(response.statusCode).toBe(204)
    expect(response.cookies.find((cookie) => cookie.name === 'refresh_token')?.value).toBe('')

    for (const code of codes) {
      expect(await t.redis.exists(`url:${code}`, `clicks:${code}`)).toBe(0)
      expect(await t.redis.sismember('clicks:dirty', code)).toBe(0)
      const redirect = await t.app.inject({ method: 'GET', url: `/${code}`, headers: BROWSER })
      expect(redirect.statusCode).toBe(404)
    }
    expect(await t.redis.exists(`quota:create:${session.userId}`)).toBe(0)

    expect(await t.prisma.user.count({ where: { id: session.userId } })).toBe(0)
    expect(await t.prisma.session.count({ where: { userId: session.userId } })).toBe(0)
    expect(await t.prisma.url.count({ where: { shortCode: { in: codes } } })).toBe(0)
    expect((await refresh(session.refreshToken)).statusCode).toBe(401)
    expect((await login(session.email, PASSWORD)).statusCode).toBe(401)

    expect((await t.app.inject({ method: 'GET', url: `/${keptCode}`, headers: BROWSER })).statusCode).toBe(302)
    expect(await t.redis.exists(`url:${keptCode}`, `clicks:${keptCode}`)).toBe(2)

    await emailTo(session.email, /deleted/i)
  })

  it('refuses a wrong password and keeps everything', async () => {
    const session = await register(t.app)
    const code = await createUrl(session)

    const response = await call('DELETE', 'me', { password: 'nope' }, bearer(session))
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'INVALID_PASSWORD' })
    expect(await t.prisma.url.count({ where: { shortCode: code } })).toBe(1)
    expect((await call('DELETE', 'me', {}, bearer(session))).statusCode).toBe(400)
  })

  it('answers 401 for a session whose account is already gone', async () => {
    const session = await register(t.app)
    expect((await call('DELETE', 'me', { password: PASSWORD }, bearer(session))).statusCode).toBe(204)
    expect((await call('DELETE', 'me', { password: PASSWORD }, bearer(session))).statusCode).toBe(401)
  })
})
