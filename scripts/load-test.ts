import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import autocannon from 'autocannon'

import { LOADTEST_USER_EMAIL, LOADTEST_USER_PASSWORD, readCodesFile, resolveTargetUrl } from './loadtest.shared'

type Options = autocannon.Options
type Result = autocannon.Result
type ACRequest = autocannon.Request

type ScenarioName = 'read' | 'mixed'

const RESULTS_DIR = resolve(__dirname, '..', 'loadtest-results')

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'all' },
    duration: { type: 'string', default: '20' },
    connections: { type: 'string', default: '50' },
    pipelining: { type: 'string', default: '1' },
    url: { type: 'string' },
    json: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
})

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const target = (values.url ?? resolveTargetUrl()).replace(/\/+$/, '')
const duration = positiveInt(values.duration, 20)
const connections = positiveInt(values.connections, 50)
const pipelining = positiveInt(values.pipelining, 1)

const codes = readCodesFile()

function randomCode(): string {
  return codes[Math.floor(Math.random() * codes.length)]
}

async function acquireToken(): Promise<string> {
  const body = JSON.stringify({ email: LOADTEST_USER_EMAIL, password: LOADTEST_USER_PASSWORD })
  const headers = { 'content-type': 'application/json' }

  let res = await fetch(`${target}/api/v1/auth/login`, { method: 'POST', headers, body })

  // First ever run against a fresh DB — register the fixture account once.
  if (res.status === 401 || res.status === 404) {
    res = await fetch(`${target}/api/v1/auth/register`, { method: 'POST', headers, body })
  }

  if (res.status === 429) {
    throw new Error('Auth endpoint is rate-limited (429). Wait ~60s and retry, or restart the app.')
  }

  if (!res.ok) {
    throw new Error(`Could not obtain an access token: HTTP ${res.status} — ${await res.text()}`)
  }

  const payload = (await res.json()) as { accessToken?: unknown }

  if (typeof payload.accessToken !== 'string') {
    throw new Error('Auth response did not contain an accessToken')
  }

  return payload.accessToken
}

// A browser User-Agent keeps the redirects on the click-counting path; bots skip it.
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

function readScenario(): Options {
  return {
    url: target,
    connections,
    duration,
    pipelining,
    title: 'read-heavy redirects — GET /:code',
    requests: [
      {
        method: 'GET',
        headers: BROWSER_HEADERS,
        setupRequest: (request: ACRequest): ACRequest => {
          request.path = `/${randomCode()}`
          return request
        },
      },
    ],
  }
}

function mixedScenario(token: string): Options {
  const get = (): ACRequest => ({
    method: 'GET',
    headers: BROWSER_HEADERS,
    setupRequest: (request: ACRequest): ACRequest => {
      request.path = `/${randomCode()}`
      return request
    },
  })

  const post: ACRequest = {
    method: 'POST',
    path: '/api/v1/urls',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // `setupRequest` runs before autocannon computes Content-Length, so a per-request
    // unique body stays consistent with its header (unlike autocannon's `idReplacement`).
    setupRequest: (request: ACRequest): ACRequest => {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      request.body = JSON.stringify({ url: `https://example.com/loadtest/created/${nonce}` })
      return request
    },
  }

  // 9 reads : 1 write, cycled per connection.
  const requests: ACRequest[] = [get(), get(), get(), get(), get(), get(), get(), get(), get(), post]

  return {
    url: target,
    connections,
    duration,
    pipelining: 1,
    title: 'mixed 90/10 read/write — GET /:code + POST /api/v1/urls',
    requests,
  }
}

function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()}ms`
}

function mbPerSecond(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1_048_576).toFixed(2)} MB/s`
}

function report(name: ScenarioName, result: Result): boolean {
  const responses = result['1xx'] + result['2xx'] + result['3xx'] + result['4xx'] + result['5xx']

  const lines = [
    `  target      ${result.url}`,
    `  load        ${result.connections} connections · ${result.pipelining} pipelining · ${result.duration}s`,
    `  requests    ${result.requests.total} sent · ${result.requests.average.toFixed(0)} req/s avg` +
      ` (min ${result.requests.min}, max ${result.requests.max})`,
    `  latency     avg ${ms(result.latency.mean)} · p50 ${ms(result.latency.p50)} · p90 ${ms(result.latency.p90)}` +
      ` · p99 ${ms(result.latency.p99)} · p99.9 ${ms(result.latency.p99_9)} · max ${ms(result.latency.max)}`,
    `  throughput  ${mbPerSecond(result.throughput.average)} avg`,
    `  responses   ${responses} total — 2xx ${result['2xx']} · 3xx ${result['3xx']} · 4xx ${result['4xx']}` +
      ` · 5xx ${result['5xx']} · 1xx ${result['1xx']}`,
    `  failures    ${result.errors} errors · ${result.timeouts} timeouts · ${result.mismatches} mismatches` +
      ` · ${result.non2xx} non-2xx`,
  ]

  const problems: string[] = []
  if (result.errors > 0) problems.push(`${result.errors} connection error(s)`)
  if (result.timeouts > 0) problems.push(`${result.timeouts} timeout(s)`)
  if (result['5xx'] > 0) problems.push(`${result['5xx']} server error(s)`)

  if (name === 'read') {
    if (result['3xx'] === 0) problems.push('no 3xx redirects observed')
    if (result['4xx'] > 0) {
      problems.push(`${result['4xx']} 4xx response(s) — the code fixture is likely stale; re-run "pnpm loadtest:seed"`)
    }
  }

  if (name === 'mixed') {
    if (result['2xx'] === 0) problems.push('no 2xx creates observed')
    if (result['4xx'] > 0) {
      problems.push(
        `${result['4xx']} 4xx response(s) — POST /api/v1/urls is throttled; start the app with a raised ` +
          'THROTTLE_LIMIT (e.g. THROTTLE_LIMIT=1000000) for a write-path load test',
      )
    }
  }

  const pass = problems.length === 0

  console.log(`\n■ scenario "${name}" — ${result.title ?? ''}`)
  console.log(lines.join('\n'))
  console.log(`  verdict     ${pass ? 'PASS' : 'FAIL'}`)
  for (const problem of problems) {
    console.log(`              - ${problem}`)
  }

  if (values.verbose) {
    console.log('')
    console.log(autocannon.printResult(result))
  }

  if (values.json) {
    mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = resolve(RESULTS_DIR, `${stamp}-${name}.json`)
    writeFileSync(file, JSON.stringify(result, null, 2))
    console.log(`  json        ${file}`)
  }

  return pass
}

async function run(name: ScenarioName, options: Options): Promise<Result> {
  process.stdout.write(
    `\n▶ scenario "${name}" — ${options.connections ?? connections} connections ·` +
      ` ${options.pipelining ?? 1} pipelining · ${options.duration ?? duration}s\n`,
  )

  const startedAt = Date.now()
  const ticker = setInterval(() => {
    process.stdout.write(`\r  running… ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, 1_000)
  ticker.unref()

  try {
    return await autocannon(options)
  } finally {
    clearInterval(ticker)
    process.stdout.write('\r' + ' '.repeat(24) + '\r')
  }
}

async function main(): Promise<void> {
  const scenario = values.scenario
  if (scenario !== 'all' && scenario !== 'read' && scenario !== 'mixed') {
    throw new Error(`--scenario must be one of: all, read, mixed (got "${scenario}")`)
  }

  const health = await fetch(`${target}/health`).catch(() => null)
  if (!health || !health.ok) {
    throw new Error(`App is not reachable at ${target}/health — start it with "pnpm start:prod" (or "pnpm start:dev").`)
  }

  console.log(`Target ${target} · ${codes.length} short codes loaded · ${duration}s per scenario`)

  const wanted: ScenarioName[] = scenario === 'all' ? ['read', 'mixed'] : [scenario]
  let anyFailed = false

  for (const name of wanted) {
    const options = name === 'read' ? readScenario() : mixedScenario(await acquireToken())
    const result = await run(name, options)
    anyFailed = !report(name, result) || anyFailed
  }

  if (anyFailed) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error('Load test failed:', error)
  process.exitCode = 1
})
