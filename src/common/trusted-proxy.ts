import type { IncomingMessage } from 'node:http'

import proxyAddr from '@fastify/proxy-addr'

import { env } from '@/config/env'

const PRIVATE_RANGES = ['loopback', 'linklocal', 'uniquelocal']

/**
 * Decides which peers may set `X-Forwarded-For`, per `TRUSTED_PROXY`. Shared by Fastify
 * (`request.ip`, used by the throttler and sessions) and the request log, so both see the same IP.
 */
export const trustProxy: (address: string, hop: number) => boolean =
  env.TRUSTED_PROXY === 'all' ? () => true : proxyAddr.compile(env.TRUSTED_PROXY === 'private' ? PRIVATE_RANGES : [])

export function clientIp(req: IncomingMessage): string {
  return proxyAddr(req, trustProxy)
}
