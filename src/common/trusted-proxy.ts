import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

import proxyAddr from '@fastify/proxy-addr'
import { Logger } from '@nestjs/common'

import { env, type Env } from '@/config/env'

const PRIVATE_RANGES = ['loopback', 'linklocal', 'uniquelocal']
const MISMATCH_WARN_INTERVAL_MS = 60_000

export const PROXY_SECRET_HEADER = 'x-proxy-secret'
export const CLIENT_IP_HEADER = 'x-client-ip'

type TrustFunction = (address: string, hop: number) => boolean

function compileTrust(mode: Env['TRUSTED_PROXY']): TrustFunction {
  return mode === 'all' ? () => true : proxyAddr.compile(mode === 'private' ? PRIVATE_RANGES : [])
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * Builds the client-IP resolver. A request carrying the front's shared secret in `x-proxy-secret`
 * is identified by its `x-client-ip`; any other request by `X-Forwarded-For`, trusted only from the
 * peers `TRUSTED_PROXY` allows. A wrong or missing secret falls back silently apart from a
 * throttled warning, so a misconfigured front degrades to a shared IP instead of failing requests.
 */
export function createClientIpResolver(
  config: Pick<Env, 'TRUSTED_PROXY' | 'FRONT_PROXY_SECRET'>,
): (req: IncomingMessage) => string {
  const trust = compileTrust(config.TRUSTED_PROXY)
  const secretDigest = config.FRONT_PROXY_SECRET ? digest(config.FRONT_PROXY_SECRET) : undefined
  const logger = new Logger('ClientIp')
  let lastWarnAt = 0

  return (req) => {
    const presented = header(req, PROXY_SECRET_HEADER)

    if (secretDigest && presented !== undefined) {
      if (timingSafeEqual(digest(presented), secretDigest)) {
        const forwarded = header(req, CLIENT_IP_HEADER)
        if (forwarded && isIP(forwarded)) {
          return forwarded
        }
      } else if (Date.now() - lastWarnAt >= MISMATCH_WARN_INTERVAL_MS) {
        lastWarnAt = Date.now()
        logger.warn(`Ignoring a request with a wrong ${PROXY_SECRET_HEADER} header`)
      }
    }

    return proxyAddr(req, trust)
  }
}

/** Fastify's `trustProxy`, so `request.ip` and `request.protocol` follow `TRUSTED_PROXY`. */
export const trustProxy: TrustFunction = compileTrust(env.TRUSTED_PROXY)

/** The client IP used by rate limits, session records and the request log. */
export const clientIp = createClientIpResolver(env)
