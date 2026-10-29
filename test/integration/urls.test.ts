import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ClicksService } from '@/modules/urls/clicks.service'

import { bearer, register, type Session } from './helpers/auth'
import { BROWSER, startApp, type TestApp } from './helpers/app'

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

async function createUrl(session: Session, url: string, note?: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/urls',
    headers: bearer(session),
    payload: { url, note },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ shortCode: string; shortUrl: string; originalUrl: string; note: string | null }>()
}

describe('POST /api/v1/urls', () => {
  it('requires an access token', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/urls',
      payload: { url: 'https://example.com' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('creates a short link for the normalised URL', async () => {
    const session = await register(t.app)
    const created = await createUrl(session, '  HTTPS://Example.COM/A B  ')

    expect(created).toEqual({
      shortCode: expect.stringMatching(/^[0-9A-Za-z]{7}$/),
      shortUrl: `http://sho.rt/${created.shortCode}`,
      originalUrl: 'https://example.com/A%20B',
      note: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
    const row = await t.prisma.url.findUniqueOrThrow({ where: { shortCode: created.shortCode } })
    expect(row.userId).toBe(session.userId)
  })

  it('stores the note', async () => {
    const session = await register(t.app)
    const created = await createUrl(session, 'https://example.com', '  spring campaign ')

    expect(created.note).toBe('spring campaign')
    expect((await t.prisma.url.findUniqueOrThrow({ where: { shortCode: created.shortCode } })).note).toBe(
      'spring campaign',
    )
  })

  it('gives a duplicate URL a fresh code', async () => {
    const session = await register(t.app)
    const a = await createUrl(session, 'https://example.com')
    const b = await createUrl(session, 'https://example.com')
    expect(a.shortCode).not.toBe(b.shortCode)
  })

  it.each(['ftp://example.com', 'not a url', ''])('rejects "%s"', async (url) => {
    const session = await register(t.app)
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/urls',
      headers: bearer(session),
      payload: { url },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/v1/urls', () => {
  it("lists the caller's links newest first, with paging", async () => {
    const session = await register(t.app)
    const stranger = await register(t.app)
    await createUrl(stranger, 'https://stranger.example')
    for (const n of [1, 2, 3]) {
      await createUrl(session, `https://example.com/${n}`)
    }

    const page = await t.app.inject({ method: 'GET', url: '/api/v1/urls?limit=2&offset=0', headers: bearer(session) })
    expect(page.statusCode).toBe(200)
    const body = page.json<{ items: { originalUrl: string; clicks: number }[]; total: number }>()
    expect(body).toMatchObject({ total: 3, limit: 2, offset: 0 })
    expect(body.items.map((item) => item.originalUrl)).toEqual(['https://example.com/3', 'https://example.com/2'])
    expect(body.items[0].clicks).toBe(0)
    expect(body.items[0]).toHaveProperty('note', null)

    const rest = await t.app.inject({ method: 'GET', url: '/api/v1/urls?limit=2&offset=2', headers: bearer(session) })
    expect(rest.json<{ items: { originalUrl: string }[] }>().items.map((item) => item.originalUrl)).toEqual([
      'https://example.com/1',
    ])
  })

  it('rejects an out-of-range limit', async () => {
    const session = await register(t.app)
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/urls?limit=500', headers: bearer(session) })
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/v1/urls/:shortCode', () => {
  it('returns the link with its note and clicks', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com', 'docs')

    const response = await t.app.inject({ method: 'GET', url: `/api/v1/urls/${shortCode}`, headers: bearer(session) })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      shortCode,
      shortUrl: `http://sho.rt/${shortCode}`,
      originalUrl: 'https://example.com/',
      note: 'docs',
      clicks: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
  })

  it('requires an access token', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com')
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/urls/${shortCode}` })).statusCode).toBe(401)
  })

  it("answers 404 for someone else's, an unknown or a malformed code", async () => {
    const owner = await register(t.app)
    const intruder = await register(t.app)
    const { shortCode } = await createUrl(owner, 'https://example.com')

    for (const code of [shortCode, 'zzzzzzz', 'bad-code']) {
      const response = await t.app.inject({ method: 'GET', url: `/api/v1/urls/${code}`, headers: bearer(intruder) })
      expect(response.statusCode).toBe(404)
    }
  })
})

describe('PATCH /api/v1/urls/:shortCode', () => {
  it('changes the destination and evicts the cached redirect', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://old.example')
    expect((await t.app.inject({ method: 'GET', url: `/${shortCode}` })).headers.location).toBe('https://old.example/')

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(session),
      payload: { url: 'https://new.example' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ shortCode, originalUrl: 'https://new.example/', clicks: 0 })
    expect((await t.app.inject({ method: 'GET', url: `/${shortCode}` })).headers.location).toBe('https://new.example/')
  })

  it('changes only the note and keeps the cached redirect', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com', 'draft')
    await t.app.inject({ method: 'GET', url: `/${shortCode}` })
    expect(await t.redis.get(`url:${shortCode}`)).toBe('https://example.com/')

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(session),
      payload: { note: 'final' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ shortCode, originalUrl: 'https://example.com/', note: 'final' })
    expect(await t.redis.get(`url:${shortCode}`)).toBe('https://example.com/')
  })

  it('clears the note with null', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com', 'draft')

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(session),
      payload: { note: null },
    })

    expect(response.json()).toMatchObject({ note: null })
    expect((await t.prisma.url.findUniqueOrThrow({ where: { shortCode } })).note).toBeNull()
  })

  it('rejects an empty body', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com')

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(session),
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it("answers 404 for someone else's link and leaves it unchanged", async () => {
    const owner = await register(t.app)
    const intruder = await register(t.app)
    const { shortCode } = await createUrl(owner, 'https://owner.example')

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(intruder),
      payload: { url: 'https://evil.example' },
    })

    expect(response.statusCode).toBe(404)
    expect((await t.prisma.url.findUniqueOrThrow({ where: { shortCode } })).originalUrl).toBe('https://owner.example/')
  })

  it('answers 404 for an unknown or malformed code', async () => {
    const session = await register(t.app)
    for (const code of ['zzzzzzz', 'bad-code']) {
      const response = await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/urls/${code}`,
        headers: bearer(session),
        payload: { url: 'https://example.com' },
      })
      expect(response.statusCode).toBe(404)
    }
  })
})

describe('DELETE /api/v1/urls/:shortCode', () => {
  it('deletes the link, its cached redirect and its pending clicks', async () => {
    const session = await register(t.app)
    const { shortCode } = await createUrl(session, 'https://example.com')
    expect((await t.app.inject({ method: 'GET', url: `/${shortCode}`, headers: BROWSER })).statusCode).toBe(302)
    await expect.poll(() => t.redis.get(`clicks:${shortCode}`)).toBe('1')

    const response = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(session),
    })

    expect(response.statusCode).toBe(204)
    expect(await t.prisma.url.count()).toBe(0)
    expect(await t.redis.exists(`clicks:${shortCode}`)).toBe(0)
    expect(await t.redis.sismember('clicks:dirty', shortCode)).toBe(0)
    expect((await t.app.inject({ method: 'GET', url: `/${shortCode}` })).statusCode).toBe(404)

    await t.app.get(ClicksService).flush()
    expect(await t.prisma.url.count()).toBe(0)
  })

  it("answers 404 for someone else's link", async () => {
    const owner = await register(t.app)
    const intruder = await register(t.app)
    const { shortCode } = await createUrl(owner, 'https://example.com')

    const response = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/urls/${shortCode}`,
      headers: bearer(intruder),
    })

    expect(response.statusCode).toBe(404)
    expect(await t.prisma.url.count()).toBe(1)
  })
})
