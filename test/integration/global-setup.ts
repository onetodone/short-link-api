import { execFileSync } from 'node:child_process'

import type { TestProject } from 'vitest/node'

/**
 * Applies the migrations to the test database before the integration tests run. The tests empty
 * every table and every Redis key under their prefix, so both must be clearly test-only.
 */
export default function setup(project: TestProject): void {
  const { DATABASE_URL: databaseUrl, REDIS_KEY_PREFIX: redisPrefix } = project.config.env
  if (!databaseUrl) throw new Error('DATABASE_URL is not set for the integration tests')

  const databaseName = new URL(databaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Integration tests empty the database; "${databaseName}" doesn't end in "_test"`)
  }
  if (!redisPrefix?.includes('test')) {
    throw new Error(`Integration tests empty Redis keys under "${redisPrefix}"; the prefix must contain "test"`)
  }

  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    })
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer }
    throw new Error(`prisma migrate deploy failed:\n${String(stdout ?? '')}${String(stderr ?? '')}`, {
      cause: error,
    })
  }
}
