import { vi } from 'vitest'

import { TURNSTILE_SITEVERIFY_URL } from '@/modules/auth/turnstile.client'

/** Cloudflare's testing keys: site and secret keys that always pass. */
export const TURNSTILE_TESTING_KEYS = {
  siteKey: '1x00000000000000000000AA',
  secretKey: '1x0000000000000000000000000000000AA',
}

/** A token the stand-in accepts for `action`. */
export function validToken(action: string): string {
  return `valid:${action}`
}

/**
 * Replaces `fetch` with a stand-in for `siteverify`: `validToken(action)` passes and is reported
 * with its action, any other token is rejected, and `fail()` makes every check error out. Any other
 * request throws.
 */
export function stubTurnstile() {
  const state = { failing: false }
  const requests: Record<string, string>[] = []

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    if (input !== TURNSTILE_SITEVERIFY_URL) throw new Error(`Unexpected request to ${input as string}`)
    const body = Object.fromEntries(init?.body as URLSearchParams)
    requests.push(body)

    if (state.failing) return Promise.resolve(new Response('error', { status: 500 }))
    const action = /^valid:(.+)$/.exec(body.response ?? '')?.[1]
    const result = action ? { success: true, action } : { success: false, 'error-codes': ['invalid-input-response'] }
    return Promise.resolve(Response.json(result))
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    requests,
    fail(failing = true) {
      state.failing = failing
    },
    reset() {
      requests.length = 0
      state.failing = false
    },
  }
}
