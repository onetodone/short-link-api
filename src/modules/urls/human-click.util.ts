import type { IncomingHttpHeaders } from 'node:http'

import { isbot } from 'isbot'

// Real traffic repeats a small set of User-Agents, and a miss scans isbot's whole pattern; churn
// past the cap only costs the scan again.
const MAX_CACHED_AGENTS = 1000
const botVerdicts = new Map<string, boolean>()

function isBotAgent(userAgent: string): boolean {
  let verdict = botVerdicts.get(userAgent)
  if (verdict === undefined) {
    verdict = isbot(userAgent)
    if (botVerdicts.size >= MAX_CACHED_AGENTS) botVerdicts.clear()
    botVerdicts.set(userAgent, verdict)
  }
  return verdict
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isPrefetch(headers: IncomingHttpHeaders): boolean {
  if (first(headers['sec-purpose'])?.includes('prefetch')) return true
  const legacy = first(headers.purpose) ?? first(headers['x-purpose']) ?? first(headers['x-moz'])
  return legacy === 'prefetch' || legacy === 'preview'
}

/**
 * Whether a redirect request is a person following the link. Bots, link-preview crawlers, browser
 * prefetches, `HEAD` probes and requests without a `User-Agent` are not.
 */
export function isHumanClick(method: string, headers: IncomingHttpHeaders): boolean {
  if (method !== 'GET' || isPrefetch(headers)) return false
  const userAgent = headers['user-agent']
  return userAgent !== undefined && userAgent !== '' && !isBotAgent(userAgent)
}
