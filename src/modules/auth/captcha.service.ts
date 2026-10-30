import { Injectable, Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'

import {
  CaptchaFailedException,
  CaptchaRequiredException,
  CaptchaUnavailableException,
} from '@/modules/auth/auth.errors'
import { type CaptchaAction, TurnstileClient } from '@/modules/auth/turnstile.client'
import { InjectRedis } from '@/redis/redis.constants'

const LOGIN_CAPTCHA_AFTER_FAILURES = 3
const LOGIN_FAILURES_WINDOW_MS = 15 * 60_000

function accountFailuresKey(email: string): string {
  return `login-failures:email:${email}`
}

function loginFailureKeys(ip: string | undefined, email: string): string[] {
  return ip ? [accountFailuresKey(email), `login-failures:ip:${ip}`] : [accountFailuresKey(email)]
}

/** Turnstile checks on the public auth forms and the failed sign-in counters that turn it on for login. */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name)

  constructor(
    private readonly turnstile: TurnstileClient,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Passes when the check is off or `token` is a valid Turnstile token for `action`. Fails closed:
   * throws `CaptchaRequiredException` without a token, `CaptchaFailedException` for a rejected one
   * and `CaptchaUnavailableException` when Cloudflare can't be reached.
   */
  async verify(token: string | undefined, action: CaptchaAction, ip: string | undefined): Promise<void> {
    if (!this.turnstile.enabled) return
    if (!token) throw new CaptchaRequiredException()

    const result = await this.turnstile.verify(token, action, ip)
    if (result === 'failed') throw new CaptchaFailedException()
    if (result === 'unavailable') throw new CaptchaUnavailableException()
  }

  /**
   * Whether a sign-in needs the check: it is on, and the IP or the account has reached the failure
   * threshold in the current window. A Redis failure answers `false`.
   */
  async loginRequired(ip: string | undefined, email: string): Promise<boolean> {
    if (!this.turnstile.enabled) return false
    try {
      const counts = await this.redis.mget(...loginFailureKeys(ip, email))
      return counts.some((count) => Number(count) >= LOGIN_CAPTCHA_AFTER_FAILURES)
    } catch (error) {
      this.logger.warn(`Login failure counters unavailable: ${(error as Error).message}`)
      return false
    }
  }

  /** Counts a failed sign-in for the IP and the account; returns whether the next attempt needs the check. */
  async recordLoginFailure(ip: string | undefined, email: string): Promise<boolean> {
    if (!this.turnstile.enabled) return false
    try {
      const transaction = this.redis.multi()
      for (const key of loginFailureKeys(ip, email)) {
        transaction.set(key, 0, 'PX', LOGIN_FAILURES_WINDOW_MS, 'NX').incr(key)
      }
      const results = (await transaction.exec()) ?? []
      return results.some(([, value], index) => index % 2 === 1 && Number(value) >= LOGIN_CAPTCHA_AFTER_FAILURES)
    } catch (error) {
      this.logger.warn(`Failed to count a login failure: ${(error as Error).message}`)
      return false
    }
  }

  /** Lifts the account's failure count, so its owner signs in without the check after a password reset. */
  async clearLoginFailures(email: string): Promise<void> {
    try {
      await this.redis.del(accountFailuresKey(email))
    } catch (error) {
      this.logger.warn(`Failed to clear the login failures of <${email}>: ${(error as Error).message}`)
    }
  }
}
