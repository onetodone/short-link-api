import path from 'node:path'

import { config as loadEnv } from 'dotenv'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

loadEnv({ quiet: true })

/**
 * Database for integration tests: `TEST_DATABASE_URL`, else `DATABASE_URL` with `_test` appended to
 * the database name, so the tests never run against the development database.
 */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL
  if (!process.env.DATABASE_URL) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run integration tests')
  const url = new URL(process.env.DATABASE_URL)
  url.pathname = `${url.pathname}_test`
  return url.toString()
}

const sharedEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  CORS_ORIGIN: '*',
  JWT_SECRET: 'test-secret-test-secret-test-secret',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  TRUSTED_PROXY: 'private',
  SHORT_URL_BASE: 'http://sho.rt',
}

const resolve = {
  alias: [
    { find: /^@prisma-client$/, replacement: path.resolve(import.meta.dirname, 'prisma/generated/client.ts') },
    { find: /^@prisma-client\/(.*)$/, replacement: path.resolve(import.meta.dirname, 'prisma/generated/$1') },
    { find: /^@\/(.*)$/, replacement: path.resolve(import.meta.dirname, 'src/$1') },
  ],
}

// Nest's dependency injection reads decorator metadata, which esbuild doesn't emit.
const plugins = [swc.vite({ module: { type: 'es6' } })]

export default defineConfig({
  test: {
    projects: [
      {
        plugins,
        resolve,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          env: { ...sharedEnv, DATABASE_URL: 'postgresql://unit:unit@localhost:5432/unit_test' },
        },
      },
      {
        plugins,
        resolve,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // One database and one Redis prefix for every file.
          fileParallelism: false,
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 60_000,
          env: {
            ...sharedEnv,
            DATABASE_URL: testDatabaseUrl(),
            REDIS_KEY_PREFIX: 'shortlink-test:',
            THROTTLE_LIMIT: '10000',
            CLICKS_FLUSH_INTERVAL_MS: '3600000',
            SESSION_CLEANUP_INTERVAL_MS: '3600000',
          },
        },
      },
    ],
  },
})
