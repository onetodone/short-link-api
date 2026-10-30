import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { linkToken, nextIp, PASSWORD, uniqueEmail } from './helpers/auth'
import { startApp, type TestApp } from './helpers/app'
import { stubTurnstile, TURNSTILE_TESTING_KEYS, validToken } from '../turnstile-double'

// The environment is parsed when the app is imported, so the keys have to be in place before that.
vi.hoisted(() => {
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA'
  process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'
})

let t: TestApp
const turnstile = stubTurnstile()

beforeAll(async () => {
  t = await startApp()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await t.reset()
  turnstile.reset()
})

function post(path: string, payload: object, ip = nextIp()) {
  return t.app.inject({ method: 'POST', url: `/api/v1/auth/${path}`, headers: { 'x-forwarded-for': ip }, payload })
}

async function createAccount(email = uniqueEmail()): Promise<string> {
  const response = await post('register', { email, password: PASSWORD, captchaToken: validToken('register') })
  expect(response.statusCode).toBe(201)
  turnstile.reset()
  return email
}

function login(email: string, ip: string, extra: { password?: string; captchaToken?: string } = {}) {
  return post('login', { email, password: extra.password ?? PASSWORD, captchaToken: extra.captchaToken }, ip)
}

async function failLogin(email: string, ip: string) {
  const response = await login(email, ip, { password: 'wrong password' })
  expect(response.statusCode).toBe(401)
  return response.json<{ captchaRequired: boolean }>().captchaRequired
}

describe('GET /api/v1/config', () => {
  it('exposes the Turnstile site key', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/config' })
    expect(response.json()).toEqual({ turnstileSiteKey: TURNSTILE_TESTING_KEYS.siteKey, oauthProviders: [] })
  })
})

describe('registration', () => {
  it('requires a token', async () => {
    const response = await post('register', { email: uniqueEmail(), password: PASSWORD })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })
    expect(turnstile.requests).toHaveLength(0)
    expect(await t.prisma.user.count()).toBe(0)
  })

  it.each([
    ['a rejected token', 'forged'],
    ['a token for another form', validToken('login')],
  ])('refuses %s', async (_case, captchaToken) => {
    const response = await post('register', { email: uniqueEmail(), password: PASSWORD, captchaToken })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'CAPTCHA_FAILED' })
    expect(await t.prisma.user.count()).toBe(0)
  })

  it('lets a valid token through and sends the secret and the client IP', async () => {
    const ip = nextIp()
    const response = await post(
      'register',
      { email: uniqueEmail(), password: PASSWORD, captchaToken: validToken('register') },
      ip,
    )
    expect(response.statusCode).toBe(201)
    expect(turnstile.requests).toEqual([
      { secret: TURNSTILE_TESTING_KEYS.secretKey, response: validToken('register'), remoteip: ip },
    ])
  })

  it('fails closed when Cloudflare is unreachable', async () => {
    turnstile.fail()
    const response = await post('register', {
      email: uniqueEmail(),
      password: PASSWORD,
      captchaToken: validToken('register'),
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'CAPTCHA_UNAVAILABLE' })
    expect(await t.prisma.user.count()).toBe(0)
  })
})

describe('password reset request', () => {
  it('requires a valid token for the form', async () => {
    const email = await createAccount()
    expect((await post('password/forgot', { email })).json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })
    expect((await post('password/forgot', { email, captchaToken: validToken('register') })).json()).toMatchObject({
      code: 'CAPTCHA_FAILED',
    })

    const response = await post('password/forgot', { email, captchaToken: validToken('forgot-password') })
    expect(response.statusCode).toBe(204)
    await vi.waitFor(() => expect(t.mail.some((message) => message.text.includes('/reset-password'))).toBe(true))
  })
})

describe('login', () => {
  it('signs in without a token until the account has failed 3 times', async () => {
    const email = await createAccount()

    expect(await failLogin(email, nextIp())).toBe(false)
    expect(await failLogin(email, nextIp())).toBe(false)
    expect((await login(email, nextIp())).statusCode).toBe(200)
    expect(await failLogin(email, nextIp())).toBe(true)
    expect(turnstile.requests).toHaveLength(0)

    const withoutToken = await login(email, nextIp())
    expect(withoutToken.statusCode).toBe(400)
    expect(withoutToken.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })

    const wrongForm = await login(email, nextIp(), { captchaToken: validToken('register') })
    expect(wrongForm.json()).toMatchObject({ code: 'CAPTCHA_FAILED' })

    const withToken = await login(email, nextIp(), { captchaToken: validToken('login') })
    expect(withToken.statusCode).toBe(200)
  })

  it('asks for the check before looking at the password', async () => {
    const email = await createAccount()
    const ip = nextIp()
    for (let attempt = 0; attempt < 3; attempt += 1) await failLogin(email, ip)

    const response = await login(email, ip, { password: 'wrong password' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })
  })

  it('asks every account signing in from an IP with 3 failures', async () => {
    const ip = nextIp()
    expect(await failLogin(uniqueEmail(), ip)).toBe(false)
    expect(await failLogin(uniqueEmail(), ip)).toBe(false)
    expect(await failLogin(uniqueEmail(), ip)).toBe(true)

    const email = await createAccount()
    expect((await login(email, ip)).json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })
    expect((await login(email, nextIp())).statusCode).toBe(200)
  })

  it('lifts the account count after a password reset', async () => {
    const email = await createAccount()
    for (let attempt = 0; attempt < 3; attempt += 1) await failLogin(email, nextIp())

    await post('password/forgot', { email, captchaToken: validToken('forgot-password') })
    await vi.waitFor(() => expect(t.mail.some((message) => message.text.includes('/reset-password'))).toBe(true))
    const reset = t.mail.find((message) => message.text.includes('/reset-password'))
    if (!reset) throw new Error('no reset email')
    const newPassword = 'another correct password'
    expect((await post('password/reset', { token: linkToken(reset), password: newPassword })).statusCode).toBe(204)

    expect((await login(email, nextIp(), { password: newPassword })).statusCode).toBe(200)
  })
})
