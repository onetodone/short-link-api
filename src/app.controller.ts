import { Controller, Get, Header } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SkipThrottle } from '@nestjs/throttler'

import { API_PREFIX } from '@/common/api-prefix'
import { TurnstileClient } from '@/modules/auth/turnstile.client'

/** Settings the frontend needs at runtime, so it doesn't duplicate them in its own environment. */
export interface PublicConfig {
  turnstileSiteKey: string | null
  oauthProviders: string[]
}

@SkipThrottle()
@Controller(API_PREFIX)
export class AppController {
  private readonly version: string
  private readonly publicConfig: PublicConfig

  constructor(config: ConfigService, turnstile: TurnstileClient) {
    this.version = config.get<string>('app.version', '0.0.0')
    this.publicConfig = { turnstileSiteKey: turnstile.siteKey, oauthProviders: [] }
  }

  @Get()
  info(): { name: string; version: string } {
    return { name: 'short-link-api', version: this.version }
  }

  @Get('config')
  @Header('Cache-Control', 'public, max-age=300')
  config(): PublicConfig {
    return this.publicConfig
  }
}
