import type { ConfigService } from '@nestjs/config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { MetricsService } from '@/modules/metrics/metrics.service'
import type { ClicksService } from '@/modules/urls/clicks.service'
import type { DestinationChecksService } from '@/modules/urls/destination-checks.service'
import { isHumanClick } from '@/modules/urls/human-click.util'
import { RedirectController } from '@/modules/urls/redirect.controller'
import { LINK_DISABLED, type UrlsService } from '@/modules/urls/urls.service'

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

describe('isHumanClick', () => {
  it('counts a browser GET', () => {
    expect(isHumanClick('GET', { 'user-agent': CHROME })).toBe(true)
  })

  it.each([
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0 A',
    'curl/8.5.0',
  ])('ignores the automated client %s', (userAgent) => {
    expect(isHumanClick('GET', { 'user-agent': userAgent })).toBe(false)
  })

  it('ignores a request without a User-Agent', () => {
    expect(isHumanClick('GET', {})).toBe(false)
    expect(isHumanClick('GET', { 'user-agent': '' })).toBe(false)
  })

  it('ignores HEAD', () => {
    expect(isHumanClick('HEAD', { 'user-agent': CHROME })).toBe(false)
  })

  it.each([
    { 'sec-purpose': 'prefetch;prerender' },
    { purpose: 'prefetch' },
    { 'x-purpose': 'preview' },
    { 'x-moz': 'prefetch' },
  ])('ignores a browser prefetch (%o)', (headers) => {
    expect(isHumanClick('GET', { 'user-agent': CHROME, ...headers })).toBe(false)
  })
})

describe('RedirectController', () => {
  function controller(redirectStatus: number, resolved = 'https://example.com/target') {
    const urls = { resolve: vi.fn().mockResolvedValue(resolved) }
    const clicks = { increment: vi.fn() }
    const destinationChecks = { schedule: vi.fn() }
    const config = { get: () => redirectStatus, getOrThrow: () => 'https://app.test' }
    const instance = new RedirectController(
      urls as unknown as UrlsService,
      clicks as unknown as ClicksService,
      destinationChecks as unknown as DestinationChecksService,
      new MetricsService(),
      config as unknown as ConfigService,
    )
    const reply = { header: vi.fn() }
    const request = { method: 'GET', headers: { 'user-agent': CHROME } }
    const redirect = () =>
      instance.redirect('abc1234', request as unknown as FastifyRequest, reply as unknown as FastifyReply)
    return { instance, redirect, reply, clicks, destinationChecks }
  }

  it('sends a 302 that browsers must not reuse', async () => {
    const { redirect, reply } = controller(302)
    await expect(redirect()).resolves.toEqual({ url: 'https://example.com/target', statusCode: 302 })
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, max-age=0')
  })

  it('sends a 301 without Cache-Control when configured', async () => {
    const { redirect, reply, clicks } = controller(301)
    await expect(redirect()).resolves.toEqual({ url: 'https://example.com/target', statusCode: 301 })
    expect(reply.header).not.toHaveBeenCalled()
    expect(clicks.increment).toHaveBeenCalledWith('abc1234')
  })

  it('queues a destination re-check without waiting for it', async () => {
    const { redirect, destinationChecks } = controller(302)
    await redirect()
    expect(destinationChecks.schedule).toHaveBeenCalledWith('abc1234')
  })

  it('sends a disabled link to the front page that explains it, whatever the redirect status', async () => {
    const { redirect, reply, clicks } = controller(301, LINK_DISABLED)
    await expect(redirect()).resolves.toEqual({ url: 'https://app.test/link-disabled', statusCode: 302 })
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, max-age=0')
    expect(clicks.increment).not.toHaveBeenCalled()
  })

  it('never re-checks a disabled link', async () => {
    const { redirect, destinationChecks } = controller(302, LINK_DISABLED)
    await redirect()
    expect(destinationChecks.schedule).not.toHaveBeenCalled()
  })

  it('sends the site root to the front', () => {
    expect(controller(301).instance.home()).toEqual({ url: 'https://app.test', statusCode: 302 })
  })
})
