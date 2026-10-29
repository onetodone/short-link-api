# Short Link API

[![CI Status](https://github.com/onetodone/short-link-api/actions/workflows/ci.yml/badge.svg)](https://github.com/onetodone/short-link-api/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.1-blue.svg)](./package.json)
[![pnpm](https://img.shields.io/badge/pnpm-v12-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)

The backend HTTP service (`@onetodone/short-link-api`) for a high-performance URL shortener, built for
the read path. Redirects are served from a Redis cache-aside layer with stampede protection, click
analytics are buffered in Redis and flushed to Postgres in batches, and the `301` response never
waits on a database write.

- **Framework:** NestJS 12 on the **Fastify** adapter
- **Storage:** PostgreSQL via Prisma 7 (`prisma-client` generator, `pg` driver adapter)
- **Cache / buffer:** Redis via `ioredis`
- **Validation:** `zod` DTOs through `nestjs-zod`
- **Auth:** stateless access JWT + Postgres-backed rotating refresh sessions (revocable, reuse-detecting), custom guard — no Passport
- **Observability:** `nestjs-pino` structured logs, Prometheus `/metrics`, `/health` + `/health/ready`
- **Rate limiting:** `@nestjs/throttler` (in-memory, per-IP)

---

## Request flow

```
POST /api/v1/urls                       GET /:shortCode
  JwtAuthGuard                            (public, @SkipThrottle)
  ThrottlerGuard (global)                 code regex guard  -> 404 on junk
  ZodValidationPipe                       UrlsService.resolve(code)
  UrlsService.create()                      1. in-process Promise dedupe map
    generateShortCode (async CSPRNG)        2. Redis GET  -> hit / negative sentinel
    prisma.url.create (retry on P2002)      3. miss: SET NX lock -> prisma.findUnique
  -> 201 { shortCode, shortUrl, ... }              -> SET EX (url | "not-found")
                                           ClicksService.increment(code)   (fire-and-forget)
                                         -> 301 Location: <originalUrl>

ClicksService: INCR shortlink:clicks:{code} + SADD shortlink:clicks:dirty
               setInterval(flush): GETDEL each dirty code -> one prisma.$transaction of updateMany
```

---

## Requirements

- **Node.js 22+** and **pnpm**
- **PostgreSQL 18** and **Redis**, reachable at the addresses configured in `.env`
  (`DATABASE_URL`, `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`). Create the database
  before running the migrations.

---

## Setup

```bash
pnpm install                         # also runs `prisma generate` (postinstall)
cp .env.example .env                 # then edit DATABASE_URL / JWT_SECRET / ports
pnpm prisma:migrate                  # apply migrations
pnpm db:seed                         # optional: 1 demo user + 4 demo short Links
```

### Run

```bash
pnpm start:dev                       # watch mode, pino-pretty logs, :3000
# or
pnpm build && pnpm start:prod        # compiled dist/, JSON logs
```

The service listens on `PORT` (`3000` if unset in `.env`) on `0.0.0.0`.

---

## API

`API_PREFIX` (default `api/v1`) applies to every route **except** the public redirect and the ops
endpoints (`/health`, `/health/ready`, `/metrics`).

| Method & path                    | Auth                                 | Body                                               | Result                                                                                                    |
| -------------------------------- | ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/register`     | –                                    | `{ email, password }` (password 8–128)             | `201 { user, accessToken }` + `refresh_token` cookie                                                      |
| `POST /api/v1/auth/login`        | –                                    | `{ email, password }`                              | `200 { user, accessToken }` + `refresh_token` cookie                                                      |
| `POST /api/v1/auth/refresh`      | `refresh_token` cookie               | –                                                  | `200 { user, accessToken }` + rotated `refresh_token` cookie                                              |
| `POST /api/v1/auth/logout`       | Bearer access token                  | –                                                  | `204` — revokes this session · clears the cookie                                                          |
| `POST /api/v1/auth/logout-all`   | Bearer access token                  | –                                                  | `204` — revokes every session the caller owns                                                             |
| `GET /api/v1/auth/me`            | Bearer access token                  | –                                                  | `200 { id, email, createdAt }`                                                                            |
| `POST /api/v1/urls`              | Bearer access token                  | `{ url }` (`http`/`https`, ≤ 2048 chars)           | `201 { shortCode, shortUrl, originalUrl, createdAt, updatedAt }`                                          |
| `GET /api/v1/urls`               | Bearer access token                  | `?limit` (1–100, def. 20), `?offset` (≥ 0, def. 0) | `200 { items[], total, limit, offset }` — caller's URLs, newest first                                     |
| `PATCH /api/v1/urls/:shortCode`  | Bearer access token (**owner only**) | `{ url }` (only the destination is mutable)        | `200 { shortCode, shortUrl, originalUrl, clicks, createdAt, updatedAt }` · `404` unknown **or** not owner |
| `DELETE /api/v1/urls/:shortCode` | Bearer access token (**owner only**) | –                                                  | `204` · `404` unknown **or** not owner                                                                    |
| `GET /:shortCode`                | –                                    | –                                                  | `301 Location: <originalUrl>` · `404` unknown / malformed                                                 |
| `GET /health`                    | –                                    | –                                                  | `200 { status: "ok" }` (liveness)                                                                         |
| `GET /health/ready`              | –                                    | –                                                  | `200 { status, database, redis }` · `503` if a dependency is down                                         |
| `GET /metrics`                   | –                                    | –                                                  | `200` Prometheus text exposition                                                                          |
| `GET /api/v1`                    | –                                    | –                                                  | `200 { name, version }`                                                                                   |

### Sessions & token rotation

The access token is a stateless 15-minute JWT carrying a `sid` (session) claim. The refresh token is
**not** a JWT — it is the opaque string `sessionId.secret`, and only `sha256(secret)` is stored, in a
`sessions` row created per login. It travels solely in the `httpOnly`, `SameSite=Strict`
`refresh_token` cookie scoped to `/api/v1/auth`; it is never in a response body.

`POST /auth/refresh` rotates the session **in place** — same row and `sid`, new secret, extended
expiry. For a 30 s grace window after a rotation, a request that still carries the pre-rotation secret
**converges** on the current token (a fresh access token, the current refresh cookie re-asserted)
instead of failing — so parallel browser tabs racing on the same cookie don't log each other out.
**After** the window, a retired secret means the token was copied: the whole session is deleted
(taking any attacker-rotated copy with it) and a `warn` is logged. `POST /auth/logout` revokes the
current session, `POST /auth/logout-all` revokes all of the caller's; expired rows are also swept
hourly (`SESSION_CLEANUP_INTERVAL_MS`).

The submitted URL is normalised (`new URL().href`) before it is stored, so
`  HTTPS://Example.COM/A B  ` persists as `https://example.com/A%20B`. Duplicate URLs always get a
fresh short code — there is no uniqueness on `originalUrl`.

`GET /api/v1/urls` returns the authenticated caller's URLs only, newest first, as
`{ shortCode, shortUrl, originalUrl, clicks, createdAt, updatedAt }`. `total` is the caller's full
count (for paging); `clicks` is the value last flushed from the Redis buffer, so it can trail the
live count by up to `CLICKS_FLUSH_INTERVAL_MS`.

`PATCH` and `DELETE` act on a single short code and require the caller to own it. A code that the
caller does not own is indistinguishable from one that does not exist — both return `404`, so the
API never confirms that a code is registered to another account. `PATCH` changes **only** the destination URL (it
is re-normalised the same way as on create) and bumps `updatedAt`. Both operations keep Redis
consistent: the cached destination is evicted on either, and `DELETE` also drops the code's pending
click buffer so a later flush cannot revive a deleted row.

### Routing

The JSON API controllers each carry `API_PREFIX`, resolved from the `src/config/env.ts` helper
(which loads `.env` on import) so the prefix is known before the `@Controller()` decorators
evaluate. The redirect and the ops
endpoints are mounted at the root. A single global prefix is not used: it can only keep the bare
`GET /:shortCode` redirect at the root by `exclude`-ing the `:shortCode` pattern, which also strips
the prefix from every other single-segment route (e.g. `GET /api/v1/urls`).

### Example

```bash
# register -> capture the access token
TOKEN=$(curl -sX POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"password123"}' | jq -r .accessToken)

# create
curl -sX POST localhost:3000/api/v1/urls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/long/path"}'
# { "shortCode":"aB3xK9p", "shortUrl":"http://localhost:3000/aB3xK9p", ... }

# resolve (1st = Cache Miss, 2nd = Cache Hit; both 301)
curl -si localhost:3000/aB3xK9p | head -1
```

---

## Configuration

Every variable is parsed, coerced, and defaulted in one place — `src/config/env.ts`. Nothing else
in `src/` reads `process.env`; the `registerAs` factories and the module-load helpers all consume
the `env` object it exports. An invalid `.env` fails fast at startup.

| Key                                            | Default                   | Purpose                                        |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------- |
| `NODE_ENV`                                     | `development`             | `development` \| `production` \| `test`        |
| `PORT`                                         | `3000`                    | HTTP listen port                               |
| `API_PREFIX`                                   | `api/v1`                  | Prefix for the JSON API                        |
| `CORS_ORIGIN`                                  | –                         | Comma-separated allow-list (`*` = reflect any) |
| `COOKIE_SECRET`                                | –                         | Optional `@fastify/cookie` signing secret      |
| `TRUSTED_PROXY`                                | `private`                 | Peers allowed to set `X-Forwarded-For`         |
| `DATABASE_URL`                                 | –                         | Postgres connection string (required)          |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `localhost` / `6379` / –  | Redis connection                               |
| `REDIS_KEY_PREFIX`                             | `shortlink:`              | Prefix on every Redis key                      |
| `REDIS_TLS`                                    | `false`                   | `true` for TLS-only providers (e.g. Upstash)   |
| `LOG_LEVEL`                                    | `debug` dev / `info` prod | pino level                                     |
| `SLOW_QUERY_THRESHOLD_MS`                      | `200`                     | Prisma queries at/above this are `warn`-logged |
| `SHORT_URL_BASE`                               | `http://localhost:$PORT`  | Base used to build the returned `shortUrl`     |
| `SHORT_CODE_LENGTH`                            | `7`                       | base62 code length                             |
| `SHORT_CODE_MAX_RETRIES`                       | `5`                       | Collision retries before `503`                 |
| `CACHE_TTL_SECONDS`                            | `3600`                    | Positive cache TTL                             |
| `CACHE_NEGATIVE_TTL_SECONDS`                   | `60`                      | Negative (unknown-code) cache TTL              |
| `CACHE_LOCK_TTL_MS`                            | `3000`                    | `SET NX` stampede-lock TTL                     |
| `CLICKS_FLUSH_INTERVAL_MS`                     | `5000`                    | Click-buffer flush cadence                     |
| `THROTTLE_TTL` / `THROTTLE_LIMIT`              | `60000` / `100`           | Global per-IP rate limit (ms / requests)       |
| `JWT_SECRET`                                   | –                         | ≥ 16 chars, signs the access token (required)  |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN`    | `15m` / `7d`              | Access-token lifetime / refresh-session TTL    |
| `SESSION_CLEANUP_INTERVAL_MS`                  | `3600000`                 | Expired-session sweep cadence (min `60000`)    |

---

## Observability

- **`GET /health`** — process liveness, always `200 { status: "ok" }`.
- **`GET /health/ready`** — races `SELECT 1` and `redis.ping()` behind a 1 s timeout;
  `503 { status: "degraded", database, redis }` if either is down.
- **`GET /metrics`** — Prometheus counters (`text/plain; version=0.0.4`, `Cache-Control: no-store`):

  | Metric                      | Meaning                                                      |
  | --------------------------- | ------------------------------------------------------------ |
  | `cache_hits_total`          | resolutions served from Redis (incl. negative-sentinel hits) |
  | `cache_misses_total`        | resolutions that fell through to Postgres                    |
  | `urls_created_total`        | successful `POST /api/v1/urls`                               |
  | `http_redirects_total`      | successful `301` responses                                   |
  | `clicks_flushed_total`      | buffered clicks reconciled into Postgres                     |
  | `clicks_flush_errors_total` | flush cycles that failed and were re-buffered                |
  | `process_uptime_seconds`    | gauge, seconds since the registry was created                |

- **Logs** — every request logs `method`, `url`, `remoteAddress`, `responseTime`, and `userId`
  (when authenticated). `authorization` / `cookie` headers and `password` / `token` fields are
  redacted. `Cache Hit` / `Cache Miss` are emitted at `debug`.

### Client IP

Rate limits, session records and request logs (`clientIp`) key on the client IP. It is taken from
`X-Forwarded-For` only when the request arrives from a trusted peer, so a client that reaches the app
directly can't pick its own IP by sending the header. `TRUSTED_PROXY` sets which peers are trusted:

- `private` (default) — loopback and private networks: nginx on the same host or a private network,
  and the frontend's Next.js proxy. The proxy must append the client address
  (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). The Next.js rewrite
  proxy forwards the header it received without adding to it, so the frontend must itself sit
  behind such a proxy; otherwise every browser request reaches the API as the frontend's own IP.
- `all` — every peer, for a proxy on a public address such as a CDN in front of the origin.
- `none` — no proxy; every request gets its socket address.

### Rate limiting

A global `ThrottlerGuard` applies `THROTTLE_LIMIT` requests per `THROTTLE_TTL` per IP. The redirect
hot path and the ops endpoints are exempt (`@SkipThrottle()`); `register` / `login` / `refresh`
tighten to a fixed **10 requests / 60 s**. Storage is in-memory (per-instance) — swap in the Redis
storage provider if you run more than one replica.

---

## Load testing

The harness lives in [`scripts/`](./scripts) and drives the app with
[`autocannon`](https://github.com/mcollina/autocannon).

### 1. Seed a dataset

```bash
pnpm loadtest:seed                 # 10 000 URLs owned by loadtest@short-link.local
pnpm loadtest:seed -- --count 50000
pnpm loadtest:seed -- --reset      # wipe the load-test rows first, then reseed
```

`seed-loadtest.ts` bulk-inserts rows directly through Prisma (chunked `createMany`) and writes the
short codes to `scripts/.loadtest-codes.txt` (git-ignored). It is idempotent: it only tops up to the
requested count unless `--reset` is passed.

### 2. Run the benchmark

Start the app first (`pnpm start:prod` is closest to production). Then:

```bash
pnpm loadtest                                   # both scenarios, 50 conns, 20 s each
pnpm loadtest -- --scenario read --duration 30 --connections 100
pnpm loadtest -- --scenario mixed --json        # write raw results to loadtest-results/
```

| Flag            | Default                                                              | Meaning                                                                         |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--scenario`    | `all`                                                                | `read` \| `mixed` \| `all`                                                      |
| `--duration`    | `20`                                                                 | seconds per scenario                                                            |
| `--connections` | `50`                                                                 | concurrent connections                                                          |
| `--pipelining`  | `1`                                                                  | pipelined requests per connection (read scenario only)                          |
| `--url`         | `$LOADTEST_TARGET_URL` → `$SHORT_URL_BASE` → `http://localhost:3000` | target base URL                                                                 |
| `--json`        | off                                                                  | dump each `autocannon` result to `loadtest-results/<timestamp>-<scenario>.json` |
| `--verbose`     | off                                                                  | also print `autocannon`'s own results table                                     |

**Scenarios**

- **`read`** — 100 % `GET /:shortCode` against random seeded codes. Every response is a `301`
  (autocannon does not follow redirects, so they show up as `3xx` / `non-2xx` — that is expected and
  counts as success).
- **`mixed`** — 9 : 1 `GET /:shortCode` to `POST /api/v1/urls`. The runner logs in as the seeded
  load-test user to get a token; each write sends a unique URL.

> **Write-path throttling.** `POST /api/v1/urls` is subject to the global rate limit. For a
> meaningful `mixed` run, start the app with a raised ceiling, e.g.
> `THROTTLE_LIMIT=1000000 pnpm start:prod`. The runner flags a scenario `FAIL` and explains why if it
> sees `4xx` responses.

### 3. Interpreting the output

Each scenario prints request rate, latency percentiles (p50 / p90 / p99 / p99.9 / max), throughput,
a status-code breakdown, and a `PASS` / `FAIL` verdict (fails on connection errors, timeouts, `5xx`,
or unexpected `4xx`). The process exits non-zero if any scenario fails.

**Indicative local numbers** (single instance, `THROTTLE_LIMIT` raised, 10 000 seeded codes,
50 connections × 20 s — your hardware will differ):

| Scenario                       | req/s   | p50  | p99   | p99.9 | errors |
| ------------------------------ | ------- | ---- | ----- | ----- | ------ |
| `read` (GET → 301)             | ~10 200 | 3 ms | 15 ms | 24 ms | 0      |
| `mixed` (90 % GET / 10 % POST) | ~6 300  | 7 ms | 15 ms | 20 ms | 0      |

During that run `cache_misses_total` settled at ~10 000 (one cold miss per seeded code, everything
else from Redis) and `clicks_flushed_total` reconciled to `http_redirects_total` in Postgres with
`clicks_flush_errors_total = 0`.

### 4. Clean up

```bash
pnpm loadtest:seed -- --reset --count 1     # drop the load-test rows
```

---

## Scripts

| Script                                  | Description                                              |
| --------------------------------------- | -------------------------------------------------------- |
| `pnpm start:dev` / `start:prod`         | run in watch mode / from compiled `dist/`                |
| `pnpm build`                            | `nest build` → `dist/src` + `dist/prisma/generated`      |
| `pnpm typecheck`                        | `tsc --noEmit`                                           |
| `pnpm lint` / `lint:ci`                 | ESLint (type-checked flat config) with / without `--fix` |
| `pnpm format` / `format:check`          | Prettier over `src`, `test`, `scripts`, `prisma`         |
| `pnpm test`                             | unit + integration tests (see [Tests](#tests))           |
| `pnpm test:unit` / `test:integration`   | one project only; unit tests need no database            |
| `pnpm prisma:migrate` / `prisma:deploy` | `prisma migrate dev` / `deploy`                          |
| `pnpm db:seed`                          | demo user + demo URLs                                    |
| `pnpm loadtest:seed`                    | populate the load-test dataset                           |
| `pnpm loadtest`                         | run the autocannon benchmark                             |
| `pnpm smoke`                            | end-to-end smoke check against a running instance        |

---

## Tests

[Vitest](https://vitest.dev) with [`unplugin-swc`](https://github.com/unplugin/unplugin-swc), which
emits the decorator metadata Nest's dependency injection needs.

- **Unit** (`test/unit/`) — pure logic: short-code generation, session token and hash helpers,
  duration parsing, env validation, the trusted-proxy rules, and the request schemas.
- **Integration** (`test/integration/`) — the whole application, built by the same `createApp()` as
  `main.ts` and driven through Fastify's `inject()`, against real Postgres and Redis: registration,
  login, throttling, refresh rotation with the grace window and reuse revocation, logout, URL CRUD
  with ownership checks and cache eviction, the redirect cache (hit, miss, negative entry, stampede
  protection), click buffering and flushing, and the ops endpoints.

Integration tests empty every table and every Redis key under their prefix, so they use a database
whose name ends in `_test` — `TEST_DATABASE_URL`, or by default the database of `DATABASE_URL` with
`_test` appended (`short_url` → `short_url_test`) — and the Redis key prefix `shortlink-test:`.
Pending migrations are applied before the run, and Prisma creates the database if it doesn't exist.

```bash
pnpm test
```

---

## Continuous integration

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on every push to `main`, every pull
request, and on demand (`workflow_dispatch`):

- **`quality`** — `pnpm install --frozen-lockfile`, `prisma validate`, `prisma generate`,
  `format:check`, `lint:ci`, `typecheck`, `build`.
- **`test`** — starts Postgres + Redis service containers and runs `pnpm test`.
- **`e2e`** — starts Postgres + Redis service containers, applies migrations, fails on any schema
  drift (`prisma migrate diff … --exit-code`), builds, boots the app, and runs `pnpm smoke`
  (`scripts/smoke.ts`) against it — liveness, readiness, auth, create, redirect, and `/metrics`.

---

## Project layout

```
src/
  main.ts                    binds the port
  app.factory.ts             createApp(): Fastify adapter (trusted proxy), logger, Zod pipe, cookie, CORS — shared with the tests
  app.module.ts              config + logger + throttler + feature modules
  config/                    env.ts (single zod-validated env helper) + registerAs factories over it
  common/load-env.ts         side-effect `.env` load, imported first by main.ts and by config/env.ts
  common/api-prefix.ts       API_PREFIX constant shared by the JSON API controllers
  common/logging/            pino config (redaction, request serializers, userId + clientIp custom props)
  common/trusted-proxy.ts    TRUSTED_PROXY trust function + clientIp(), shared by Fastify and the logger
  common/types/http.d.ts     FastifyRequest / IncomingMessage `user` augmentation
  database/                  PrismaService (pg adapter, slow-query event log) + @Global module
  redis/                     tuned ioredis client + @Global module + InjectRedis()
  modules/
    urls/                    create + list + update + delete + resolve, short-code CSPRNG, click buffer, redirect controller
    auth/                    bcrypt, access-JWT issue/verify, rotating refresh sessions + reuse detection, logout, hourly sweep
    health/                  liveness + readiness
    metrics/                 in-memory counters + Prometheus endpoint
prisma/
  schema.prisma              Url + User models
  migrations/                prisma migrate history
  seed.ts                    demo data
scripts/
  loadtest.shared.ts         fixtures shared by the two harness scripts
  seed-loadtest.ts           bulk-insert N URLs, dump codes to .loadtest-codes.txt
  load-test.ts               autocannon read-heavy + mixed scenarios
  smoke.ts                   end-to-end smoke check (used by CI)
test/
  unit/                      pure-logic tests
  integration/               whole-app tests against Postgres + Redis (helpers/ boots the app, resets state)
```

---

## License

MIT © Anton Holubeu
