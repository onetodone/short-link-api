import { isIP } from 'node:net'

import { URL_SHORTENER_HOSTS } from '@/modules/urls/url-shorteners'

export const DESTINATION_REJECTION_REASONS = [
  'CREDENTIALS_IN_URL',
  'IP_ADDRESS',
  'LOCAL_HOST',
  'OWN_DOMAIN',
  'URL_SHORTENER',
] as const

export type DestinationRejectionReason = (typeof DESTINATION_REJECTION_REASONS)[number]

// Special-use and private-network names that never resolve to a public site.
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'test', 'invalid', 'example']

/** Strips trailing dots: `bit.ly.` resolves to `bit.ly` but would get past an exact host match. */
export function hostnameOf(url: string): string {
  return new URL(url).hostname.replace(/\.+$/, '')
}

function isUnder(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/**
 * Why a destination can't be shortened, or `null` when it can. Expects an absolute http(s) URL
 * already parsed by `new URL`, which turns decimal, octal and hex IPv4 forms into dotted quads.
 */
export function destinationRejection(url: string, ownHostname: string): DestinationRejectionReason | null {
  const parsed = new URL(url)
  if (parsed.username !== '' || parsed.password !== '') return 'CREDENTIALS_IN_URL'

  const hostname = hostnameOf(url)
  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return 'IP_ADDRESS'
  if (!hostname.includes('.') || LOCAL_SUFFIXES.some((suffix) => isUnder(hostname, suffix))) return 'LOCAL_HOST'
  if (hostname === ownHostname) return 'OWN_DOMAIN'

  const labels = hostname.split('.')
  if (labels.some((_, index) => URL_SHORTENER_HOSTS.has(labels.slice(index).join('.')))) return 'URL_SHORTENER'

  return null
}
