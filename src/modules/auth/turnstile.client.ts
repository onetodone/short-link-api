import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { MetricsService } from '@/modules/metrics/metrics.service'

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5_000

/** Form a token is issued for; a token from one form is rejected by another. */
export type CaptchaAction = 'register' | 'login' | 'forgot-password'

/** Outcome of a check: passed, rejected by Turnstile, or Turnstile couldn't be reached. */
export type CaptchaResult = 'ok' | 'failed' | 'unavailable'

interface SiteverifyResponse {
  success?: boolean
  action?: string
  'error-codes'?: string[]
  metadata?: { result_with_testing_key?: boolean }
}

/** Cloudflare Turnstile `siteverify`, turned off unless both Turnstile keys are set. */
@Injectable()
export class TurnstileClient {
  private readonly logger = new Logger(TurnstileClient.name)
  private readonly secretKey: string | undefined

  /** Public key the widget is rendered with, `null` when the check is off. */
  readonly siteKey: string | null

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    const siteKey = config.get<string>('auth.turnstileSiteKey')
    const secretKey = config.get<string>('auth.turnstileSecretKey')
    const enabled = siteKey !== undefined && secretKey !== undefined
    this.siteKey = enabled ? siteKey : null
    this.secretKey = enabled ? secretKey : undefined
  }

  get enabled(): boolean {
    return this.secretKey !== undefined
  }

  /**
   * Checks `token` with Cloudflare. Never throws: gives `ok` when the check is off, `failed` for a
   * token Cloudflare rejects or one issued for another action, and `unavailable` on HTTP errors,
   * timeouts and malformed responses.
   */
  async verify(token: string, action: CaptchaAction, ip: string | undefined): Promise<CaptchaResult> {
    if (this.secretKey === undefined) return 'ok'

    this.metrics.increment('captcha_checks_total')
    const body = new URLSearchParams({ secret: this.secretKey, response: token })
    if (ip) body.set('remoteip', ip)

    let result: SiteverifyResponse
    try {
      const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      result = (await response.json()) as SiteverifyResponse
    } catch (error) {
      this.metrics.increment('captcha_errors_total')
      this.logger.warn(`Turnstile check failed: ${(error as Error).message}`)
      return 'unavailable'
    }

    // Cloudflare's testing secret keys answer without the token's action.
    const actionMatches = result.action === action || result.metadata?.result_with_testing_key === true
    if (result.success === true && actionMatches) return 'ok'

    this.metrics.increment('captcha_rejected_total')
    this.logger.warn(
      `Turnstile rejected a "${action}" token (action: ${result.action ?? '-'}, errors: ${result['error-codes']?.join(', ') || '-'})`,
    )
    return 'failed'
  }
}
