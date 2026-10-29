import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClicksService } from '@/modules/urls/clicks.service'

import packageJson from '../../package.json'

import { BROWSER, startApp, type TestApp } from './helpers/app'

let t: TestApp
let urlQueries = 0

beforeAll(async () => {
  t = await startApp()
  t.prisma.$on('query', (event) => {
    if (event.query.includes('"urls"') && event.query.startsWith('SELECT')) urlQueries += 1
  })
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await t.reset()
  urlQueries = 0
})

async function seedUrl(shortCode: string, originalUrl = 'https://example.com/target') {
  await t.prisma.url.create({ data: { shortCode, originalUrl } })
}

function metric(text: string, name: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${name} `))
  return Number(line?.split(' ')[1])
}

async function metrics(): Promise<string> {
  return (await t.app.inject({ method: 'GET', url: '/metrics' })).body
}

describe('GET /:shortCode', () => {
  it('redirects with an uncacheable 302, filling the cache on the first hit and reading it afterwards', async () => {
    await seedUrl('abc1234')
    const before = await metrics()

    const first = await t.app.inject({ method: 'GET', url: '/abc1234' })
    const second = await t.app.inject({ method: 'GET', url: '/abc1234' })

    for (const response of [first, second]) {
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('https://example.com/target')
      expect(response.headers['cache-control']).toBe('private, max-age=0')
    }
    expect(await t.redis.get('url:abc1234')).toBe('https://example.com/target')
    expect(urlQueries).toBe(1)

    const after = await metrics()
    expect(metric(after, 'cache_misses_total') - metric(before, 'cache_misses_total')).toBe(1)
    expect(metric(after, 'cache_hits_total') - metric(before, 'cache_hits_total')).toBe(1)
    expect(metric(after, 'http_redirects_total') - metric(before, 'http_redirects_total')).toBe(2)
  })

  it('looks a code up once for a burst of concurrent misses', async () => {
    await seedUrl('burst01')
    const lookups = vi.spyOn(t.prisma.url, 'findUnique')

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => t.app.inject({ method: 'GET', url: '/burst01' })),
    )

    expect(responses.every((response) => response.statusCode === 302)).toBe(true)
    expect(lookups).toHaveBeenCalledTimes(1)
    lookups.mockRestore()
  })

  it('waits for another instance that holds the fill lock instead of reading the database', async () => {
    await seedUrl('locked1', 'https://example.com/from-database')
    await t.redis.set('lock:locked1', '1', 'PX', 3000)
    const lookups = vi.spyOn(t.prisma.url, 'findUnique')
    setTimeout(() => void t.redis.set('url:locked1', 'https://example.com/from-other-instance', 'EX', 60), 60)

    const response = await t.app.inject({ method: 'GET', url: '/locked1' })

    expect(response.headers.location).toBe('https://example.com/from-other-instance')
    expect(lookups).not.toHaveBeenCalled()
    lookups.mockRestore()
  })

  it('caches an unknown code as a negative entry', async () => {
    const first = await t.app.inject({ method: 'GET', url: '/missing1' })
    const second = await t.app.inject({ method: 'GET', url: '/missing1' })

    expect(first.statusCode).toBe(404)
    expect(second.statusCode).toBe(404)
    expect(await t.redis.get('url:missing1')).toBe('not-found')
    expect(urlQueries).toBe(1)
  })

  it.each(['/abc', '/has-dash', `/${'a'.repeat(33)}`])(
    'answers 404 for the malformed path %s without a lookup',
    async (path) => {
      expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(404)
      expect(urlQueries).toBe(0)
    },
  )

  it('buffers clicks in Redis and flushes them to Postgres', async () => {
    await seedUrl('click01')
    for (let n = 0; n < 3; n += 1) {
      await t.app.inject({ method: 'GET', url: '/click01', headers: BROWSER })
    }

    await expect.poll(() => t.redis.get('clicks:click01')).toBe('3')
    expect(await t.redis.sismember('clicks:dirty', 'click01')).toBe(1)
    expect((await t.prisma.url.findUniqueOrThrow({ where: { shortCode: 'click01' } })).clicks).toBe(0)

    await t.app.get(ClicksService).flush()

    expect((await t.prisma.url.findUniqueOrThrow({ where: { shortCode: 'click01' } })).clicks).toBe(3)
    expect(await t.redis.exists('clicks:click01')).toBe(0)
    expect(await t.redis.scard('clicks:dirty')).toBe(0)
  })
})

describe('click counting', () => {
  it.each([
    ['a link-preview crawler', { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }],
    ['a search bot', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }],
    ['a browser prefetch', { ...BROWSER, 'sec-purpose': 'prefetch' }],
  ])('redirects %s without counting a click', async (_label, headers) => {
    await seedUrl('bot0001')
    const before = await metrics()

    const response = await t.app.inject({ method: 'GET', url: '/bot0001', headers })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('https://example.com/target')
    expect(await t.redis.exists('clicks:bot0001')).toBe(0)
    const after = await metrics()
    expect(metric(after, 'http_redirects_bot_total') - metric(before, 'http_redirects_bot_total')).toBe(1)
    expect(metric(after, 'http_redirects_total') - metric(before, 'http_redirects_total')).toBe(1)
  })

  it('answers HEAD with the redirect without counting a click', async () => {
    await seedUrl('head001')

    const response = await t.app.inject({ method: 'HEAD', url: '/head001', headers: BROWSER })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('https://example.com/target')
    expect(await t.redis.exists('clicks:head001')).toBe(0)
  })

  it('counts a browser click and leaves the bot counter alone', async () => {
    await seedUrl('human01')
    const before = await metrics()

    await t.app.inject({ method: 'GET', url: '/human01', headers: BROWSER })

    await expect.poll(() => t.redis.get('clicks:human01')).toBe('1')
    const after = await metrics()
    expect(metric(after, 'http_redirects_bot_total') - metric(before, 'http_redirects_bot_total')).toBe(0)
  })
})

describe('ops endpoints', () => {
  it('reports liveness and readiness', async () => {
    const live = await t.app.inject({ method: 'GET', url: '/health' })
    const ready = await t.app.inject({ method: 'GET', url: '/health/ready' })

    expect(live.json()).toEqual({ status: 'ok' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ status: 'ok', database: 'up', redis: 'up' })
  })

  it('exposes Prometheus counters', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/metrics' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toContain('# TYPE cache_hits_total counter')
    expect(response.body).toContain('process_uptime_seconds')
  })

  it('serves the API info route', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1' })
    expect(response.json()).toEqual({ name: 'short-link-api', version: packageJson.version })
  })
})
