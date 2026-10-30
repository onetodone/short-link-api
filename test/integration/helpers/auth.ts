import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import { PrismaService } from '@/database/prisma.service'

export const PASSWORD = 'correct horse battery'

let counter = 0

/**
 * A distinct client IP per call. Requests come from loopback, which `TRUSTED_PROXY=private` trusts,
 * so each test gets its own rate-limit bucket on the credential routes.
 */
export function nextIp(): string {
  counter += 1
  return `198.51.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}`
}

export function uniqueEmail(): string {
  counter += 1
  return `user${counter}@example.com`
}

export interface Session {
  userId: string
  email: string
  accessToken: string
  /** Value of the `refresh_token` cookie. */
  refreshToken: string
}

export function refreshCookie(response: { cookies: { name: string; value: string }[] }): string | undefined {
  return response.cookies.find((cookie) => cookie.name === 'refresh_token')?.value
}

/** Registers a fresh account and returns its tokens. The address counts as confirmed unless `verified` is false. */
export async function register(
  app: NestFastifyApplication,
  email = uniqueEmail(),
  { verified = true }: { verified?: boolean } = {},
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'x-forwarded-for': nextIp() },
    payload: { email, password: PASSWORD, acceptTerms: true },
  })
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`)
  }

  const body = response.json<{ user: { id: string; email: string }; accessToken: string }>()
  const refreshToken = refreshCookie(response)
  if (!refreshToken) throw new Error('register set no refresh_token cookie')

  if (verified) {
    await app.get(PrismaService).user.update({ where: { id: body.user.id }, data: { emailVerifiedAt: new Date() } })
  }

  return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken, refreshToken }
}

export function bearer(session: Session): { authorization: string } {
  return { authorization: `Bearer ${session.accessToken}` }
}

/** The `token` query parameter of the first link in an email's text. */
export function linkToken(message: { text: string }): string {
  const token = /[?&]token=([\w-]+)/.exec(message.text)?.[1]
  if (!token) throw new Error(`no token link in email:\n${message.text}`)
  return token
}
