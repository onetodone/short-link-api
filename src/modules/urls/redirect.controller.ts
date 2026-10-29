import { Controller, Get, NotFoundException, Param, Redirect, Req, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SkipThrottle } from '@nestjs/throttler'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { MetricsService } from '@/modules/metrics/metrics.service'
import { ClicksService } from '@/modules/urls/clicks.service'
import { isHumanClick } from '@/modules/urls/human-click.util'
import { SHORT_CODE_PATTERN } from '@/modules/urls/short-code.util'
import { UrlsService } from '@/modules/urls/urls.service'

@SkipThrottle()
@Controller()
export class RedirectController {
  private readonly statusCode: number

  constructor(
    private readonly urls: UrlsService,
    private readonly clicks: ClicksService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.statusCode = config.get<number>('shortener.redirectStatus', 302)
  }

  @Get(':shortCode')
  @Redirect()
  async redirect(
    @Param('shortCode') shortCode: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ url: string; statusCode: number }> {
    if (!SHORT_CODE_PATTERN.test(shortCode)) {
      throw new NotFoundException('Short code not found')
    }

    const url = await this.urls.resolve(shortCode)

    if (isHumanClick(request.method, request.headers)) {
      this.clicks.increment(shortCode)
    } else {
      this.metrics.increment('http_redirects_bot_total')
    }
    this.metrics.increment('http_redirects_total')

    // A cached 301 never comes back here: an edited destination wouldn't reach returning visitors
    // and their repeat clicks would go uncounted.
    if (this.statusCode === 302) {
      reply.header('Cache-Control', 'private, max-age=0')
    }

    return { url, statusCode: this.statusCode }
  }
}
