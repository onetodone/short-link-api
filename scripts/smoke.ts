import { execFileSync } from 'node:child_process'

/**
 * End-to-end smoke test for CI (and a handy local pre-push check).
 *
 * Assumes the app is already listening on BASE_URL. Walks the critical path:
 * liveness, readiness (Postgres + Redis), the reported version, the public config, register, the
 * guarded create endpoint, email verification, a refused destination, the redirect (cache miss then
 * hit), a bot that is redirected but not counted as a click, an unknown-code 404, the Prometheus
 * /metrics counters, the refresh-session lifecycle (rotate, a racing tab converges, logout
 * revokes), a password reset, the moderation commands (a disabled link lands on the front's notice
 * page, a suspended account can't sign in), and account management (change the password, change the
 * email, delete the account, after which its link no longer resolves). Exits non-zero on the first
 * failed check.
 *
 * The app must send its email to a Mailpit instance whose HTTP API is at MAILPIT_URL; the
 * verification, reset and email-change links are read from there. The moderation commands run from
 * the build (`dist/`) with the same environment, so they reach the app's database and Redis.
 *
 * With Turnstile on, registration and the reset request send Cloudflare's dummy token, which only
 * the always-pass testing secret key accepts; run the smoke with Turnstile off or with that key.
 *
 *   node dist/src/main &
 *   BASE_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 pnpm smoke
 */

const BASE_URL = (process.env.BASE_URL ?? process.env.SHORT_URL_BASE ?? 'http://localhost:3000').replace(/\/+$/, '')
const API_PREFIX = (process.env.API_PREFIX ?? 'api/v1').replace(/^\/+|\/+$/g, '')
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS ?? 60_000)
const REDIRECT_STATUS = Number(process.env.REDIRECT_STATUS ?? 302)
const CLICKS_TIMEOUT_MS = Math.max(15_000, 3 * Number(process.env.CLICKS_FLUSH_INTERVAL_MS ?? 5000))
const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, '')
const MAIL_TIMEOUT_MS = 15_000
const MODERATION_CLI = 'dist/src/cli/moderation.js'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const BOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'

const apiUrl = (path: string): string => `${BASE_URL}/${API_PREFIX}/${path.replace(/^\/+/, '')}`

let checks = 0

function pass(message: string): void {
  checks += 1
  console.log(`  ok   ${message}`)
}

function assert(condition: boolean, message: string, detail?: unknown): void {
  if (condition) {
    pass(message)
    return
  }
  const suffix = detail === undefined ? '' : `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.error(`  FAIL ${message}${suffix}`)
  throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readMetric(name: string): Promise<number> {
  const text = await (await fetch(`${BASE_URL}/metrics`)).text()
  const line = text.split('\n').find((entry) => entry.startsWith(`${name} `))
  return Number(line?.split(' ')[1] ?? Number.NaN)
}

function readRefreshCookie(res: Response): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const match = /^refresh_token=([^;]+)/.exec(raw)
    if (match && match[1]) {
      return match[1]
    }
  }
  return null
}

/** Token of the newest email to `to` whose link points at `path`, read from Mailpit. */
async function emailedToken(to: string, path: string): Promise<string> {
  const pattern = new RegExp(`${path}\\?token=([\\w-]+)`)
  const deadline = Date.now() + MAIL_TIMEOUT_MS
  let lastError = 'no matching email'
  while (Date.now() < deadline) {
    try {
      const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
      const { messages = [] } = (await search.json()) as { messages?: { ID: string }[] }
      for (const { ID } of messages) {
        const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${ID}`)).json()) as { Text?: string }
        const token = pattern.exec(message.Text ?? '')?.[1]
        if (token) return token
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(500)
  }
  assert(false, `an email to ${to} with a ${path} link reached Mailpit at ${MAILPIT_URL}`, lastError)
  throw new Error('unreachable')
}

/** Runs an operator command of the built app against the same database and Redis as the app. */
function moderate(...args: string[]): void {
  try {
    execFileSync(process.execPath, [MODERATION_CLI, ...args], { stdio: 'pipe' })
    pass(`moderation ${args.join(' ')}`)
  } catch (error: unknown) {
    const { stderr } = error as { stderr?: Buffer }
    assert(false, `moderation ${args.join(' ')} succeeded`, String(stderr ?? error))
  }
}

async function waitForBoot(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`)
      if (res.ok) {
        pass(`app is up (GET /health -> ${res.status})`)
        return
      }
      lastError = `HTTP ${res.status}`
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }
  assert(false, `app did not become healthy within ${BOOT_TIMEOUT_MS}ms`, lastError)
}

async function main(): Promise<void> {
  console.log(`Smoke test -> ${BASE_URL} (API prefix /${API_PREFIX})`)

  await waitForBoot()

  // Readiness — Postgres and Redis must both be reachable.
  {
    const res = await fetch(`${BASE_URL}/health/ready`)
    const body = (await res.json().catch(() => ({}))) as { database?: unknown; redis?: unknown }
    assert(res.status === 200, `GET /health/ready -> 200 (got ${res.status})`, body)
    assert(body.database === 'up', `readiness: database up (got ${String(body.database)})`)
    assert(body.redis === 'up', `readiness: redis up (got ${String(body.redis)})`)
  }

  // API info — the version comes from package.json however the app is started.
  {
    const res = await fetch(`${BASE_URL}/${API_PREFIX}`)
    const body = (await res.json().catch(() => ({}))) as { version?: unknown }
    const expected = process.env.npm_package_version
    assert(
      expected ? body.version === expected : typeof body.version === 'string' && body.version !== '0.0.0',
      `GET /${API_PREFIX} reports version ${expected ?? '(any)'} (got ${String(body.version)})`,
    )
  }

  // Public config — the frontend reads the Turnstile site key from here.
  let captchaToken: string | undefined
  {
    const res = await fetch(apiUrl('config'))
    const body = (await res.json().catch(() => ({}))) as { turnstileSiteKey?: unknown; oauthProviders?: unknown }
    assert(res.status === 200, `GET /${API_PREFIX}/config -> 200 (got ${res.status})`, body)
    assert(
      (body.turnstileSiteKey === null || typeof body.turnstileSiteKey === 'string') &&
        Array.isArray(body.oauthProviders),
      'config reports turnstileSiteKey and oauthProviders',
      body,
    )
    if (typeof body.turnstileSiteKey === 'string') captchaToken = TURNSTILE_DUMMY_TOKEN
  }

  // Register a throwaway account and capture an access token.
  const credentials = {
    email: `smoke+${Date.now()}@short-link.test`,
    password: 'smoke-test-password-123',
  }
  const declinedRes = await fetch(apiUrl('auth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...credentials, captchaToken }),
  })
  assert(
    declinedRes.status === 400,
    `POST /${API_PREFIX}/auth/register without acceptTerms -> 400 (got ${declinedRes.status})`,
  )

  const registerRes = await fetch(apiUrl('auth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...credentials, acceptTerms: true, captchaToken }),
  })
  const registerBody = (await registerRes.json().catch(() => ({}))) as {
    accessToken?: unknown
    refreshToken?: unknown
  }
  assert(
    registerRes.status === 201,
    `POST /${API_PREFIX}/auth/register -> 201 (got ${registerRes.status})`,
    registerBody,
  )
  assert(
    typeof registerBody.accessToken === 'string' && registerBody.accessToken.length > 0,
    'register returned an accessToken',
  )
  assert(registerBody.refreshToken === undefined, 'register did not leak the refresh token in the body')
  const accessToken = registerBody.accessToken as string
  const refreshCookie = readRefreshCookie(registerRes)
  assert(typeof refreshCookie === 'string' && refreshCookie.length > 0, 'register set a refresh_token cookie')

  // The create endpoint must reject an anonymous caller.
  {
    const res = await fetch(apiUrl('urls'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/anon' }),
    })
    assert(res.status === 401, `POST /${API_PREFIX}/urls without a token -> 401 (got ${res.status})`)
  }

  // Until the address is confirmed, creating links is refused.
  {
    const res = await fetch(apiUrl('urls'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ url: 'https://example.com/unverified' }),
    })
    const body = (await res.json().catch(() => ({}))) as { code?: unknown }
    assert(res.status === 403, `POST /${API_PREFIX}/urls before verification -> 403 (got ${res.status})`, body)
    assert(body.code === 'EMAIL_NOT_VERIFIED', 'refusal carries code EMAIL_NOT_VERIFIED', body)
  }

  // Confirm the address with the link from the registration email.
  {
    const token = await emailedToken(credentials.email, '/verify-email')
    pass('registration emailed a confirmation link')
    const res = await fetch(apiUrl('auth/verify-email'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const body = (await res.json().catch(() => ({}))) as { user?: { emailVerified?: unknown } }
    assert(res.status === 200, `POST /${API_PREFIX}/auth/verify-email -> 200 (got ${res.status})`, body)
    assert(body.user?.emailVerified === true, 'verify-email reports the address as confirmed', body)
  }

  // Create a short Link.
  const target = `https://example.com/smoke/${Math.random().toString(36).slice(2)}`
  const createRes = await fetch(apiUrl('urls'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ url: target, note: 'smoke' }),
  })
  const createBody = (await createRes.json().catch(() => ({}))) as {
    shortCode?: unknown
    originalUrl?: unknown
    note?: unknown
  }
  assert(createRes.status === 201, `POST /${API_PREFIX}/urls -> 201 (got ${createRes.status})`, createBody)
  assert(
    typeof createBody.shortCode === 'string' && createBody.shortCode.length > 0,
    'create returned a shortCode',
    createBody,
  )
  assert(createBody.originalUrl === target, 'create echoed the normalised originalUrl', createBody)
  assert(createBody.note === 'smoke', 'create echoed the note', createBody)
  const shortCode = createBody.shortCode as string

  // A destination on a URL shortener is refused with a machine-readable code.
  {
    const res = await fetch(apiUrl('urls'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ url: 'https://bit.ly/smoke' }),
    })
    const body = (await res.json().catch(() => ({}))) as { code?: unknown; reason?: unknown }
    assert(res.status === 422, `POST /${API_PREFIX}/urls (shortener) -> 422 (got ${res.status})`, body)
    assert(
      body.code === 'DESTINATION_REJECTED' && body.reason === 'URL_SHORTENER',
      'refused destination carries code DESTINATION_REJECTED and reason URL_SHORTENER',
      body,
    )
  }

  // Edit the note only, then load the single link.
  {
    const res = await fetch(apiUrl(`urls/${shortCode}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ note: 'smoke edited' }),
    })
    assert(res.status === 200, `PATCH /${API_PREFIX}/urls/${shortCode} (note only) -> 200 (got ${res.status})`)
  }
  {
    const res = await fetch(apiUrl(`urls/${shortCode}`), { headers: { authorization: `Bearer ${accessToken}` } })
    const body = (await res.json().catch(() => ({}))) as { originalUrl?: unknown; note?: unknown }
    assert(res.status === 200, `GET /${API_PREFIX}/urls/${shortCode} -> 200 (got ${res.status})`, body)
    assert(
      body.originalUrl === target && body.note === 'smoke edited',
      'single link carries the edited note and the original destination',
      body,
    )
  }

  // A link-preview bot is redirected, but its hit is not counted as a click.
  const botRedirectsBefore = await readMetric('http_redirects_bot_total')
  {
    const res = await fetch(`${BASE_URL}/${shortCode}`, { redirect: 'manual', headers: { 'user-agent': BOT_UA } })
    assert(res.status === REDIRECT_STATUS, `GET /${shortCode} (bot) -> ${REDIRECT_STATUS} (got ${res.status})`)
    assert(res.headers.get('location') === target, `GET /${shortCode} (bot) Location header -> target`)
  }
  const botRedirects = (await readMetric('http_redirects_bot_total')) - botRedirectsBefore
  assert(botRedirects === 1, `/metrics http_redirects_bot_total grew by 1 (got ${botRedirects})`)

  // Resolve it twice as a browser — cache hit after the bot's miss, then another hit.
  for (const attempt of ['first', 'second'] as const) {
    const res = await fetch(`${BASE_URL}/${shortCode}`, { redirect: 'manual', headers: { 'user-agent': BROWSER_UA } })
    assert(res.status === REDIRECT_STATUS, `GET /${shortCode} (${attempt}) -> ${REDIRECT_STATUS} (got ${res.status})`)
    assert(
      res.headers.get('location') === target,
      `GET /${shortCode} (${attempt}) Location header -> target`,
      res.headers.get('location'),
    )
    if (REDIRECT_STATUS === 302) {
      const cacheControl = res.headers.get('cache-control')
      assert(cacheControl === 'private, max-age=0', `GET /${shortCode} (${attempt}) is not cacheable`, cacheControl)
    }
  }

  // Only the two browser hits reach the link's click count once the buffer is flushed.
  {
    const deadline = Date.now() + CLICKS_TIMEOUT_MS
    let clicks = 0
    while (Date.now() < deadline) {
      const res = await fetch(apiUrl('urls'), { headers: { authorization: `Bearer ${accessToken}` } })
      const body = (await res.json().catch(() => ({}))) as { items?: { shortCode: string; clicks: number }[] }
      clicks = body.items?.find((item) => item.shortCode === shortCode)?.clicks ?? 0
      if (clicks >= 2) break
      await sleep(500)
    }
    assert(clicks === 2, `GET /${API_PREFIX}/urls reports 2 clicks, the bot excluded (got ${clicks})`)
  }

  // Unknown code -> 404.
  {
    const res = await fetch(`${BASE_URL}/definitelyNotARealCode`, { redirect: 'manual' })
    assert(res.status === 404, `GET /<unknown code> -> 404 (got ${res.status})`)
  }

  // /metrics exposes the Prometheus counters.
  {
    const res = await fetch(`${BASE_URL}/metrics`)
    const text = await res.text()
    assert(res.status === 200, `GET /metrics -> 200 (got ${res.status})`)
    for (const metric of [
      'urls_created_total',
      'http_redirects_total',
      'http_redirects_bot_total',
      'cache_hits_total',
      'cache_misses_total',
    ]) {
      assert(text.includes(metric), `/metrics exposes ${metric}`)
    }
  }

  // Refresh-session lifecycle: rotate, a racing tab converges (no 401), then
  // logout revokes the session for good.
  {
    const cookie = (value: string) => ({ cookie: `refresh_token=${value}` })

    const rotateRes = await fetch(apiUrl('auth/refresh'), { method: 'POST', headers: cookie(refreshCookie as string) })
    assert(rotateRes.status === 200, `POST /${API_PREFIX}/auth/refresh (cookie) -> 200 (got ${rotateRes.status})`)
    const rotatedCookie = readRefreshCookie(rotateRes)
    assert(
      typeof rotatedCookie === 'string' && rotatedCookie.length > 0 && rotatedCookie !== refreshCookie,
      'refresh rotated the refresh_token cookie',
    )

    // A second tab still holding the pre-rotation cookie must converge on the
    // current token inside the grace window, not get a 401.
    const raceRes = await fetch(apiUrl('auth/refresh'), { method: 'POST', headers: cookie(refreshCookie as string) })
    assert(
      raceRes.status === 200,
      `POST /${API_PREFIX}/auth/refresh racing the rotation -> 200 (got ${raceRes.status})`,
    )

    const logoutRes = await fetch(apiUrl('auth/logout'), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert(logoutRes.status === 204, `POST /${API_PREFIX}/auth/logout -> 204 (got ${logoutRes.status})`)

    const afterLogoutRes = await fetch(apiUrl('auth/refresh'), {
      method: 'POST',
      headers: cookie((rotatedCookie ?? refreshCookie) as string),
    })
    assert(
      afterLogoutRes.status === 401,
      `POST /${API_PREFIX}/auth/refresh after logout -> 401 (got ${afterLogoutRes.status})`,
    )
  }

  // Password reset: the emailed link sets a new password, which then signs in.
  const resetPassword = `${credentials.password}-reset`
  let sessionToken: string
  {
    const json = { 'content-type': 'application/json' }
    const forgotRes = await fetch(apiUrl('auth/password/forgot'), {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: credentials.email, captchaToken }),
    })
    assert(forgotRes.status === 204, `POST /${API_PREFIX}/auth/password/forgot -> 204 (got ${forgotRes.status})`)

    const token = await emailedToken(credentials.email, '/reset-password')
    pass('password/forgot emailed a reset link')
    const resetRes = await fetch(apiUrl('auth/password/reset'), {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token, password: resetPassword }),
    })
    assert(resetRes.status === 204, `POST /${API_PREFIX}/auth/password/reset -> 204 (got ${resetRes.status})`)

    const loginRes = await fetch(apiUrl('auth/login'), {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: credentials.email, password: resetPassword }),
    })
    assert(
      loginRes.status === 200,
      `POST /${API_PREFIX}/auth/login with the new password -> 200 (got ${loginRes.status})`,
    )
  }

  // Moderation through the operator commands: a disabled link lands on the front's notice page, and
  // a suspended account can't sign in until the suspension is lifted.
  {
    const homeRes = await fetch(`${BASE_URL}/`, { redirect: 'manual' })
    const appUrl = homeRes.headers.get('location') ?? ''
    assert(homeRes.status === 302 && appUrl !== '', `GET / -> 302 to the front (got ${homeRes.status} ${appUrl})`)

    moderate('link:disable', shortCode)
    const disabledRes = await fetch(`${BASE_URL}/${shortCode}`, {
      redirect: 'manual',
      headers: { 'user-agent': BROWSER_UA },
    })
    assert(
      disabledRes.status === 302 && disabledRes.headers.get('location') === `${appUrl}/link-disabled`,
      `GET /${shortCode} after link:disable -> 302 ${appUrl}/link-disabled (got ${disabledRes.status} ${disabledRes.headers.get('location')})`,
    )

    moderate('link:enable', shortCode)
    const enabledRes = await fetch(`${BASE_URL}/${shortCode}`, {
      redirect: 'manual',
      headers: { 'user-agent': BOT_UA },
    })
    assert(
      enabledRes.headers.get('location') === target,
      `GET /${shortCode} after link:enable -> the destination (got ${enabledRes.headers.get('location')})`,
    )

    const json = { 'content-type': 'application/json' }
    const credentialsBody = JSON.stringify({ email: credentials.email, password: resetPassword })
    moderate('user:suspend', credentials.email)
    const suspendedRes = await fetch(apiUrl('auth/login'), { method: 'POST', headers: json, body: credentialsBody })
    const suspendedBody = (await suspendedRes.json().catch(() => ({}))) as { code?: unknown }
    assert(
      suspendedRes.status === 403 && suspendedBody.code === 'ACCOUNT_SUSPENDED',
      `POST /${API_PREFIX}/auth/login while suspended -> 403 ACCOUNT_SUSPENDED (got ${suspendedRes.status})`,
      suspendedBody,
    )

    moderate('user:unsuspend', credentials.email)
    const restoredRes = await fetch(apiUrl('auth/login'), { method: 'POST', headers: json, body: credentialsBody })
    const restoredBody = (await restoredRes.json().catch(() => ({}))) as { accessToken?: unknown }
    assert(
      restoredRes.status === 200,
      `POST /${API_PREFIX}/auth/login after user:unsuspend -> 200 (got ${restoredRes.status})`,
    )
    sessionToken = String(restoredBody.accessToken)
  }

  // Account management: change the password, move to another address, then delete the account.
  {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` }
    const password = `${resetPassword}-changed`
    const passwordRes = await fetch(apiUrl('auth/me/password'), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ currentPassword: resetPassword, newPassword: password }),
    })
    assert(passwordRes.status === 204, `PATCH /${API_PREFIX}/auth/me/password -> 204 (got ${passwordRes.status})`)

    const newEmail = `smoke+moved-${Date.now()}@short-link.test`
    const emailRes = await fetch(apiUrl('auth/me/email'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ newEmail, password }),
    })
    assert(emailRes.status === 204, `POST /${API_PREFIX}/auth/me/email -> 204 (got ${emailRes.status})`)

    const token = await emailedToken(newEmail, '/confirm-email')
    pass('me/email emailed a confirmation link to the new address')
    const confirmRes = await fetch(apiUrl('auth/email/confirm'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const confirmBody = (await confirmRes.json().catch(() => ({}))) as { user?: { email?: unknown } }
    assert(confirmRes.status === 200, `POST /${API_PREFIX}/auth/email/confirm -> 200 (got ${confirmRes.status})`)
    assert(confirmBody.user?.email === newEmail, 'email/confirm reports the new address', confirmBody)

    const deleteRes = await fetch(apiUrl('auth/me'), { method: 'DELETE', headers, body: JSON.stringify({ password }) })
    assert(deleteRes.status === 204, `DELETE /${API_PREFIX}/auth/me -> 204 (got ${deleteRes.status})`)

    const redirectRes = await fetch(`${BASE_URL}/${shortCode}`, { redirect: 'manual' })
    assert(
      redirectRes.status === 404,
      `GET /${shortCode} after the account is deleted -> 404 (got ${redirectRes.status})`,
    )

    const loginRes = await fetch(apiUrl('auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail, password }),
    })
    assert(loginRes.status === 401, `POST /${API_PREFIX}/auth/login after deletion -> 401 (got ${loginRes.status})`)
  }

  console.log(`\nSmoke test passed — ${checks} checks.`)
}

main().catch((error: unknown) => {
  console.error('\nSmoke test FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
