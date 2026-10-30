import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionCleanupService } from '@/modules/auth/session-cleanup.service'

import { bearer, linkToken, nextIp, PASSWORD, refreshCookie, register, uniqueEmail } from './helpers/auth'
import { startApp, type TestApp } from './helpers/app'

let t: TestApp

beforeAll(async () => {
  t = await startApp()
})

afterAll(async () => {
  await t.close()
})

let read = 0

beforeEach(async () => {
  await t.reset()
  read = 0
})

function post(url: string, payload?: object, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url: `/api/v1/auth/${url}`,
    headers: { 'x-forwarded-for': nextIp(), ...headers },
    payload,
  })
}

function createUrl(headers: Record<string, string>) {
  return t.app.inject({ method: 'POST', url: '/api/v1/urls', headers, payload: { url: 'https://example.com/' } })
}

/** The oldest email not yet returned by this function; sending runs in the background, so it waits. */
async function nextEmail() {
  await vi.waitFor(() => expect(t.mail.length).toBeGreaterThan(read))
  const email = t.mail[read]
  read += 1
  if (!email) throw new Error('no email')
  return email
}

describe('email verification', () => {
  it('emails a confirmation link on registration and reports the address as unconfirmed', async () => {
    const response = await post('register', { email: 'fresh@example.com', password: PASSWORD, acceptTerms: true })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ user: { email: 'fresh@example.com', emailVerified: false } })

    const email = await nextEmail()
    expect(email.to).toBe('fresh@example.com')
    expect(email.text).toMatch(/http:\/\/app\.test\/verify-email\?token=[\w-]+/)

    const tokens = await t.prisma.verificationToken.findMany()
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ type: 'EMAIL_VERIFY' })
    expect(tokens[0].tokenHash).not.toBe(linkToken(email))
  })

  it('blocks creating and editing links until the address is confirmed', async () => {
    const owner = await register(t.app)
    const code = createUrl(bearer(owner)).then((r) => r.json<{ shortCode: string }>().shortCode)
    const session = await register(t.app, uniqueEmail(), { verified: false })

    const create = await createUrl(bearer(session))
    expect(create.statusCode).toBe(403)
    expect(create.json()).toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED' })

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${await code}`,
      headers: bearer(session),
      payload: { note: 'x' },
    })
    expect(patch.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })

    const list = await t.app.inject({ method: 'GET', url: '/api/v1/urls', headers: bearer(session) })
    expect(list.statusCode).toBe(200)
  })

  it('confirms the address once, and the open session can create links at once', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    const token = linkToken(await nextEmail())

    const verified = await post('verify-email', { token })
    expect(verified.statusCode).toBe(200)
    expect(verified.json()).toEqual({ user: { id: session.userId, email: session.email, emailVerified: true } })

    expect((await createUrl(bearer(session))).statusCode).toBe(201)

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session) })
    expect(me.json()).toMatchObject({ emailVerified: true })

    const again = await post('verify-email', { token })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('rejects an unknown, expired or wrong-purpose token', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    const token = linkToken(await nextEmail())

    await t.prisma.verificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await post('verify-email', { token })).json()).toMatchObject({ code: 'INVALID_TOKEN' })
    expect((await post('verify-email', { token: 'not-a-token' })).json()).toMatchObject({ code: 'INVALID_TOKEN' })
    expect((await post('verify-email', {})).statusCode).toBe(400)

    await post('password/forgot', { email: session.email })
    const resetToken = linkToken(await nextEmail())
    expect((await post('verify-email', { token: resetToken })).json()).toMatchObject({ code: 'INVALID_TOKEN' })

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
    expect(user.emailVerifiedAt).toBeNull()
  })

  it('resends after the cooldown and retires the previous link', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    const first = linkToken(await nextEmail())

    const tooSoon = await post('verify-email/resend', undefined, bearer(session))
    expect(tooSoon.statusCode).toBe(429)
    expect(tooSoon.json()).toMatchObject({ code: 'EMAIL_COOLDOWN', retryAfter: expect.any(Number) })

    await t.redis.del(`cooldown:email:verify:${session.userId}`)
    const resent = await post('verify-email/resend', undefined, bearer(session))
    expect(resent.statusCode).toBe(204)
    const second = linkToken(await nextEmail())

    expect((await post('verify-email', { token: first })).statusCode).toBe(400)
    expect((await post('verify-email', { token: second })).statusCode).toBe(200)
  })

  it('sends nothing to a confirmed address', async () => {
    const session = await register(t.app)
    await nextEmail()

    expect((await post('verify-email/resend', undefined, bearer(session))).statusCode).toBe(204)
    expect((await post('verify-email/resend')).statusCode).toBe(401)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(t.mail).toHaveLength(1)
  })
})

describe('password reset', () => {
  it('answers the same for unknown and known addresses and emails only the account owner', async () => {
    const session = await register(t.app)
    await nextEmail()

    const unknown = await post('password/forgot', { email: 'nobody@example.com' })
    const known = await post('password/forgot', { email: session.email.toUpperCase() })
    expect(unknown.statusCode).toBe(204)
    expect(known.statusCode).toBe(204)
    expect(unknown.body).toBe(known.body)

    const email = await nextEmail()
    expect(email.to).toBe(session.email)
    expect(email.text).toMatch(/http:\/\/app\.test\/reset-password\?token=[\w-]+/)
  })

  it('sends one email per cooldown', async () => {
    const session = await register(t.app)
    await nextEmail()

    await post('password/forgot', { email: session.email })
    await nextEmail()
    await post('password/forgot', { email: session.email })
    await post('password/forgot', { email: uniqueEmail() })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(t.mail).toHaveLength(2)
    expect(await t.prisma.verificationToken.count({ where: { type: 'PASSWORD_RESET' } })).toBe(1)
  })

  it('sets the password, revokes every session and notifies the owner', async () => {
    const session = await register(t.app, uniqueEmail(), { verified: false })
    await nextEmail()
    await post('password/forgot', { email: session.email })
    const token = linkToken(await nextEmail())

    const ip = nextIp()
    const reset = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      headers: { 'x-forwarded-for': ip },
      payload: { token, password: 'a brand new password' },
    })
    expect(reset.statusCode).toBe(204)
    expect(reset.cookies.find((cookie) => cookie.name === 'refresh_token')?.value).toBe('')

    expect(await t.prisma.session.count()).toBe(0)
    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: session.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)

    const oldPassword = await post('login', { email: session.email, password: PASSWORD })
    expect(oldPassword.statusCode).toBe(401)
    const newPassword = await post('login', { email: session.email, password: 'a brand new password' })
    expect(newPassword.statusCode).toBe(200)
    expect(refreshCookie(newPassword)).toBeDefined()
    expect(newPassword.json()).toMatchObject({ user: { emailVerified: true } })

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
    expect(user.passwordChangedAt).toBeInstanceOf(Date)

    const notice = await nextEmail()
    expect(notice.to).toBe(session.email)
    expect(notice.text).toContain(ip)

    expect((await post('password/reset', { token, password: 'another new password' })).json()).toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })

  it('rejects an unknown token and a weak password without changing anything', async () => {
    const session = await register(t.app)
    await nextEmail()
    await post('password/forgot', { email: session.email })
    const token = linkToken(await nextEmail())

    expect((await post('password/reset', { token: 'nope', password: 'long enough password' })).statusCode).toBe(400)
    expect((await post('password/reset', { token, password: 'short' })).statusCode).toBe(400)

    expect(await t.prisma.session.count()).toBe(1)
    expect(await t.prisma.verificationToken.count({ where: { type: 'PASSWORD_RESET' } })).toBe(1)
  })
})

describe('token cleanup', () => {
  it('sweeps expired tokens with the session cleanup', async () => {
    await register(t.app, uniqueEmail(), { verified: false })
    await register(t.app, uniqueEmail(), { verified: false })
    await t.prisma.verificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    await register(t.app, uniqueEmail(), { verified: false })

    await t.app.get(SessionCleanupService).sweep()

    expect(await t.prisma.verificationToken.count()).toBe(1)
  })
})
