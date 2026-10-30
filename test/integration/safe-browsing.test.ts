import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModerationService } from '@/modules/moderation/moderation.service'

import { BROWSER, startApp, type TestApp } from './helpers/app'
import { bearer, register, type Session } from './helpers/auth'
import { stubSafeBrowsing } from '../safe-browsing-double'

// The environment is parsed when the app is imported, so the key has to be in place before that.
vi.hoisted(() => {
  process.env.SAFE_BROWSING_API_KEY = 'safe-browsing-test-key'
})

const HOUR = 60 * 60_000
const SAFE = 'https://example.com/safe'
const PHISHING = 'https://phishing.example.com/login'

let t: TestApp
const safeBrowsing = stubSafeBrowsing()

beforeAll(async () => {
  t = await startApp()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await t.reset()
  safeBrowsing.reset()
})

function create(session: Session, url: string) {
  return t.app.inject({ method: 'POST', url: '/api/v1/urls', headers: bearer(session), payload: { url } })
}

async function createUrl(session: Session, url = SAFE): Promise<string> {
  const response = await create(session, url)
  expect(response.statusCode).toBe(201)
  return response.json<{ shortCode: string }>().shortCode
}

function patch(session: Session, shortCode: string, payload: object) {
  return t.app.inject({ method: 'PATCH', url: `/api/v1/urls/${shortCode}`, headers: bearer(session), payload })
}

function visit(shortCode: string) {
  return t.app.inject({ method: 'GET', url: `/${shortCode}`, headers: BROWSER })
}

function stored(shortCode: string) {
  return t.prisma.url.findUniqueOrThrow({
    where: { shortCode },
    select: {
      originalUrl: true,
      disabledReason: true,
      destinationSetAt: true,
      destinationCheckedAt: true,
    },
  })
}

/** Moves a link's destination history back in time, as if it had been set and checked earlier. */
async function age(shortCode: string, { setAgo, checkedAgo }: { setAgo: number; checkedAgo: number | null }) {
  const now = Date.now()
  await t.prisma.url.update({
    where: { shortCode },
    data: {
      destinationSetAt: new Date(now - setAgo),
      destinationCheckedAt: checkedAgo === null ? null : new Date(now - checkedAgo),
    },
  })
}

const UNSAFE_REJECTION = {
  statusCode: 422,
  code: 'DESTINATION_REJECTED',
  reason: 'UNSAFE_DESTINATION',
  message: 'Destination URL is flagged as unsafe by Google Safe Browsing',
}

describe('checks on save', () => {
  it('rejects a flagged destination without using up the creation quota', async () => {
    safeBrowsing.flagged.add(PHISHING)
    const session = await register(t.app)

    const response = await create(session, PHISHING)

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject(UNSAFE_REJECTION)
    expect(await t.redis.get(`quota:create:${session.userId}`)).toBe('0')
    expect(await t.prisma.url.count()).toBe(0)
  })

  it('records the check of a clean destination, sending the API key', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)

    expect(safeBrowsing.lookups).toEqual([SAFE])
    expect(safeBrowsing.apiKeys).toEqual(new Set(['safe-browsing-test-key']))
    expect((await stored(shortCode)).destinationCheckedAt).toBeInstanceOf(Date)
  })

  it('saves the link when the lookup fails, leaving it to be checked on its next redirect', async () => {
    safeBrowsing.fail()
    const session = await register(t.app)
    const shortCode = await createUrl(session)

    expect((await stored(shortCode)).destinationCheckedAt).toBeNull()
  })

  it('rejects a flagged destination on edit and keeps the link as it was', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    safeBrowsing.flagged.add(PHISHING)

    const response = await patch(session, shortCode, { url: PHISHING })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject(UNSAFE_REJECTION)
    expect((await stored(shortCode)).originalUrl).toBe(SAFE)
  })

  it('looks a new destination up and restarts its check schedule', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await age(shortCode, { setAgo: 30 * 24 * HOUR, checkedAgo: HOUR })

    expect((await patch(session, shortCode, { url: 'https://example.com/other' })).statusCode).toBe(200)

    const after = await stored(shortCode)
    expect(safeBrowsing.lookups).toEqual([SAFE, 'https://example.com/other'])
    expect(Date.now() - after.destinationSetAt.getTime()).toBeLessThan(HOUR)
    expect(Date.now() - (after.destinationCheckedAt?.getTime() ?? 0)).toBeLessThan(HOUR)
  })

  it('sends nothing for an edit that keeps the destination', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)

    expect((await patch(session, shortCode, { url: SAFE, note: 'same' })).statusCode).toBe(200)
    expect(safeBrowsing.lookups).toEqual([SAFE])
  })
})

describe('re-checks after redirects', () => {
  it('disables a link whose destination is flagged later, without delaying the redirect', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session, PHISHING)
    await age(shortCode, { setAgo: 2 * HOUR, checkedAgo: HOUR })
    safeBrowsing.flagged.add(PHISHING)

    const first = await visit(shortCode)
    expect(first.headers.location).toBe(PHISHING)

    await vi.waitFor(async () => {
      expect((await stored(shortCode)).disabledReason).toBe('UNSAFE_DESTINATION')
    })
    expect((await visit(shortCode)).headers.location).toBe('http://app.test/link-disabled')
    await vi.waitFor(() => {
      expect(t.mail.some((message) => message.to === session.email && /disabled/.test(message.subject))).toBe(true)
    })

    expect((await patch(session, shortCode, { url: SAFE })).json()).toMatchObject({ disabled: false })
    expect((await visit(shortCode)).headers.location).toBe(SAFE)
  })

  it('looks a busy link up once', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await age(shortCode, { setAgo: 30 * 24 * HOUR, checkedAgo: null })
    safeBrowsing.reset()

    const responses = await Promise.all(Array.from({ length: 20 }, () => visit(shortCode)))

    expect(responses.every((response) => response.statusCode === 302)).toBe(true)
    await vi.waitFor(async () => {
      expect((await stored(shortCode)).destinationCheckedAt).not.toBeNull()
    })
    await visit(shortCode)
    expect(safeBrowsing.lookups).toEqual([SAFE])
  })

  it.each([
    ['a new destination checked within the hour', 2 * 24 * HOUR, 30 * 60_000, 30 * 60_000],
    ['a settled destination checked within the day', 30 * 24 * HOUR, 20 * HOUR, 4 * HOUR],
  ])('waits with %s until the next check is due', async (_, setAgo, checkedAgo, remaining) => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)
    await age(shortCode, { setAgo, checkedAgo })
    safeBrowsing.reset()

    await visit(shortCode)

    await vi.waitFor(async () => {
      expect(await t.redis.pttl(`sb:${shortCode}`)).toBeGreaterThan(remaining - 60_000)
    })
    expect(await t.redis.pttl(`sb:${shortCode}`)).toBeLessThanOrEqual(remaining)
    expect(safeBrowsing.lookups).toEqual([])
  })

  it('leaves a link whose destination changed during the lookup alone', async () => {
    const session = await register(t.app)
    const shortCode = await createUrl(session)

    const outcome = await t.app
      .get(ModerationService)
      .disableLink(shortCode, 'UNSAFE_DESTINATION', { destination: PHISHING })

    expect(outcome.changed).toBe(false)
    expect((await stored(shortCode)).disabledReason).toBeNull()
  })
})
