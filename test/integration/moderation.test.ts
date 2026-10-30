import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseModerationCommand, runModerationCommand } from '@/cli/moderation-commands'
import { ModerationError, ModerationService } from '@/modules/moderation/moderation.service'
import { ClicksService } from '@/modules/urls/clicks.service'

import { BROWSER, startApp, type TestApp } from './helpers/app'
import { bearer, nextIp, PASSWORD, refreshCookie, register, type Session } from './helpers/auth'

let t: TestApp
let moderation: ModerationService

beforeAll(async () => {
  t = await startApp()
  moderation = t.app.get(ModerationService)
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await t.reset()
})

async function createUrl(session: Session, url = 'https://example.com/target'): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/urls',
    headers: bearer(session),
    payload: { url },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ shortCode: string }>().shortCode
}

function visit(shortCode: string) {
  return t.app.inject({ method: 'GET', url: `/${shortCode}`, headers: BROWSER })
}

function detail(session: Session, shortCode: string) {
  return t.app.inject({ method: 'GET', url: `/api/v1/urls/${shortCode}`, headers: bearer(session) })
}

function login(email: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': nextIp() },
    payload: { email, password: PASSWORD },
  })
}

function run(...argv: string[]) {
  return runModerationCommand(moderation, parseModerationCommand(argv))
}

async function emailTo(to: string, subject: RegExp) {
  await vi.waitFor(() => {
    expect(t.mail.some((message) => message.to === to && subject.test(message.subject))).toBe(true)
  })
}

describe('GET /', () => {
  it('sends the redirect host root to the front', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('http://app.test')
  })
})

describe('disabled links', () => {
  it('redirect to the link-disabled page at once, uncached by browsers and without counting a click', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    expect((await visit(shortCode)).headers.location).toBe('https://example.com/target')

    await run('link:disable', shortCode)
    const clicks = vi.spyOn(t.app.get(ClicksService), 'increment')

    const response = await visit(shortCode)
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('http://app.test/link-disabled')
    expect(response.headers['cache-control']).toBe('private, max-age=0')
    expect(await t.redis.get(`url:${shortCode}`)).toBe('disabled')
    expect(clicks).not.toHaveBeenCalled()
    clicks.mockRestore()
    await emailTo(session.email, /short link was disabled/)

    const metrics = (await t.app.inject({ method: 'GET', url: '/metrics' })).body
    expect(metrics).toContain('http_redirects_disabled_total 1')
  })

  it('report disabled and disabledReason in the list and the detail', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', shortCode, '--unsafe')

    expect((await detail(session, shortCode)).json()).toMatchObject({
      disabled: true,
      disabledReason: 'UNSAFE_DESTINATION',
    })
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/urls', headers: bearer(session) })
    expect(list.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({ shortCode, disabled: true, disabledReason: 'UNSAFE_DESTINATION' }),
    ])
  })

  it('work again after link:enable, and the owner is told', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', `http://sho.rt/${shortCode}`)
    await visit(shortCode)

    expect(await run('link:enable', shortCode)).toEqual([`Link ${shortCode} enabled; owner ${session.email}`])

    expect((await visit(shortCode)).headers.location).toBe('https://example.com/target')
    expect((await detail(session, shortCode)).json()).toMatchObject({ disabled: false, disabledReason: null })
    await emailTo(session.email, /works again/)
  })

  it('report a repeated command as unchanged and send no second email', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', shortCode)
    await emailTo(session.email, /disabled/)

    expect(await run('link:disable', shortCode)).toEqual([`Link ${shortCode} unchanged (MANUAL)`])
    expect(await run('link:disable', shortCode, '--unsafe')).toEqual([`Link ${shortCode} unchanged (MANUAL)`])
    expect(t.mail).toHaveLength(2)
  })

  it('reject an unknown code or a target that is not a code', async () => {
    await expect(run('link:disable', 'zzzzzzz')).rejects.toThrow(ModerationError)
    await expect(run('link:enable', 'https://sho.rt/a/b')).rejects.toThrow('is not a short code')
    await expect(run('user:suspend', 'nobody@example.com')).rejects.toThrow('No account')
  })
})

describe('PATCH /api/v1/urls/:shortCode on a disabled link', () => {
  function patch(session: Session, shortCode: string, payload: object) {
    return t.app.inject({ method: 'PATCH', url: `/api/v1/urls/${shortCode}`, headers: bearer(session), payload })
  }

  it('re-enables an unsafe-destination link once the destination changes', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', shortCode, '--unsafe')

    const same = await patch(session, shortCode, { url: 'https://example.com/target', note: 'still here' })
    expect(same.json()).toMatchObject({ disabled: true, disabledReason: 'UNSAFE_DESTINATION', note: 'still here' })

    const moved = await patch(session, shortCode, { url: 'https://example.org/clean' })
    expect(moved.json()).toMatchObject({ disabled: false, disabledReason: null })
    expect((await visit(shortCode)).headers.location).toBe('https://example.org/clean')
  })

  it('keeps a manual disable whatever the owner changes', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', shortCode)

    const response = await patch(session, shortCode, { url: 'https://example.org/clean' })
    expect(response.json()).toMatchObject({ disabled: true, disabledReason: 'MANUAL' })
    expect((await visit(shortCode)).headers.location).toBe('http://app.test/link-disabled')
  })
})

describe('account suspension', () => {
  it('signs the account out, refuses sign-in and link changes, and disables its links', async () => {
    const session = await register(t.app)
    const first = await createUrl(session)
    const second = await createUrl(session)
    await visit(first)

    expect(await run('user:suspend', session.email)).toEqual([`Account ${session.email} suspended; 2 link(s) disabled`])

    const signIn = await login(session.email)
    expect(signIn.statusCode).toBe(403)
    expect(signIn.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED', supportEmail: 'support@example.com' })
    expect(signIn.json<{ message: string }>().message).toContain('support@example.com')

    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: session.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)
    expect(await t.prisma.session.count({ where: { userId: session.userId } })).toBe(0)

    const create = await t.app.inject({
      method: 'POST',
      url: '/api/v1/urls',
      headers: bearer(session),
      payload: { url: 'https://example.com/new' },
    })
    expect(create.statusCode).toBe(403)
    expect(create.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' })

    for (const shortCode of [first, second]) {
      expect((await visit(shortCode)).headers.location).toBe('http://app.test/link-disabled')
      expect((await detail(session, shortCode)).json()).toMatchObject({ disabledReason: 'ACCOUNT_SUSPENDED' })
    }
    await emailTo(session.email, /account is suspended/)
  })

  it('refuses a refresh token of a session that outlived the suspension', async () => {
    const session = await register(t.app)
    await t.prisma.user.update({ where: { id: session.userId }, data: { suspendedAt: new Date() } })

    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: session.refreshToken },
    })
    expect(refresh.statusCode).toBe(403)
    expect(refresh.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' })
    expect(await t.prisma.session.count({ where: { userId: session.userId } })).toBe(0)
  })

  it('lifted, restores only the links the suspension disabled', async () => {
    const session = await register(t.app)
    const restored = await createUrl(session)
    const manual = await createUrl(session)
    await run('link:disable', manual)
    await run('user:suspend', `http://sho.rt/${restored}`)

    expect(await run('user:unsuspend', restored)).toEqual([`Account ${session.email} restored; 1 link(s) re-enabled`])

    expect((await visit(restored)).headers.location).toBe('https://example.com/target')
    expect((await visit(manual)).headers.location).toBe('http://app.test/link-disabled')
    const signIn = await login(session.email)
    expect(signIn.statusCode).toBe(200)
    expect(refreshCookie(signIn)).toBeDefined()
    await emailTo(session.email, /account is restored/)
  })

  it('keeps a link enabled during the suspension off until the suspension is lifted', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await run('link:disable', shortCode)
    await run('user:suspend', session.email)

    expect(await run('link:enable', shortCode)).toEqual([
      `Link ${shortCode} enabled (ACCOUNT_SUSPENDED); owner ${session.email}`,
    ])
    expect((await visit(shortCode)).headers.location).toBe('http://app.test/link-disabled')

    await run('user:unsuspend', session.email)
    expect((await visit(shortCode)).headers.location).toBe('https://example.com/target')
  })

  it('link:disable --owner disables the link for good and suspends its owner', async () => {
    const session = await register(t.app)
    const reported = await createUrl(session)
    const other = await createUrl(session)

    expect(await run('link:disable', reported, '--owner')).toEqual([
      `Link ${reported} disabled (MANUAL); owner ${session.email}`,
      `Account ${session.email} suspended; 1 link(s) disabled`,
    ])

    await run('user:unsuspend', session.email)
    expect((await visit(reported)).headers.location).toBe('http://app.test/link-disabled')
    expect((await visit(other)).headers.location).toBe('https://example.com/target')
  })

  it('reports a repeated suspension as unchanged', async () => {
    const session = await register(t.app)
    await run('user:suspend', session.email)
    expect(await run('user:suspend', session.email.toUpperCase())).toEqual([
      `Account ${session.email} already suspended`,
    ])
    expect(await run('user:unsuspend', session.email)).toHaveLength(1)
    expect(await run('user:unsuspend', session.email)).toEqual([`Account ${session.email} is not suspended`])
  })
})
