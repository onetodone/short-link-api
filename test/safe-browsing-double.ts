import { vi } from 'vitest'

import { SAFE_BROWSING_SEARCH_URL } from '@/modules/urls/safe-browsing.client'

function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  if (bytes.length > 127) throw new Error('Test messages stay under 128 bytes')
  return [(field << 3) | 2, bytes.length, ...bytes]
}

/**
 * Binary `urls:search` response flagging `url` with Safe Browsing threat type codes (1 malware,
 * 2 social engineering); no `url` means nothing matched.
 */
export function safeBrowsingResponse(url?: string, threatTypes: number[] = []): Response {
  const body = url
    ? lengthDelimited(
        1,
        new Uint8Array([
          ...lengthDelimited(1, new TextEncoder().encode(url)),
          ...lengthDelimited(2, new Uint8Array(threatTypes)),
        ]),
      )
    : []
  return new Response(new Uint8Array(body), { status: 200 })
}

/**
 * Replaces `fetch` with a stand-in for `urls:search`: URLs in `flagged` are social engineering,
 * every other URL is clean, and `fail()` makes every lookup error out. Any other request throws.
 */
export function stubSafeBrowsing() {
  const flagged = new Set<string>()
  const state = { failing: false }
  const lookups: string[] = []
  const apiKeys = new Set<string | undefined>()

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const request = new URL(input as string)
    if (`${request.origin}${request.pathname}` !== SAFE_BROWSING_SEARCH_URL) {
      throw new Error(`Unexpected request to ${request.origin}`)
    }
    const url = request.searchParams.get('urls') ?? ''
    lookups.push(url)
    apiKeys.add((init?.headers as Record<string, string> | undefined)?.['X-Goog-Api-Key'])

    if (state.failing) return Promise.resolve(new Response('quota', { status: 429 }))
    return Promise.resolve(flagged.has(url) ? safeBrowsingResponse(url, [2]) : safeBrowsingResponse())
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    flagged,
    lookups,
    apiKeys,
    fail(failing = true) {
      state.failing = failing
    },
    reset() {
      flagged.clear()
      lookups.length = 0
      apiKeys.clear()
      state.failing = false
    },
  }
}
