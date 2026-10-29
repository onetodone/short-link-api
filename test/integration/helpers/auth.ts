import type { NestFastifyApplication } from '@nestjs/platform-fastify'

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

/** Registers a fresh account and returns its tokens. */
export async function register(app: NestFastifyApplication, email = uniqueEmail()): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'x-forwarded-for': nextIp() },
    payload: { email, password: PASSWORD },
  })
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`)
  }

  const body = response.json<{ user: { id: string; email: string }; accessToken: string }>()
  const refreshToken = refreshCookie(response)
  if (!refreshToken) throw new Error('register set no refresh_token cookie')

  return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken, refreshToken }
}

export function bearer(session: Session): { authorization: string } {
  return { authorization: `Bearer ${session.accessToken}` }
}
