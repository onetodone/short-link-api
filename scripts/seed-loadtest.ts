import 'dotenv/config'

import { parseArgs } from 'node:util'

import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

import { PrismaClient } from '../prisma/generated/client'
import { generateShortCode } from '../src/modules/urls/short-code.util'
import { CODES_FILE, LOADTEST_USER_EMAIL, LOADTEST_USER_PASSWORD, writeCodesFile } from './loadtest.shared'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — cannot seed the load-test dataset')
}

const CODE_LENGTH = Number(process.env.SHORT_CODE_LENGTH ?? '7')
const INSERT_CHUNK = 1_000
const DEFAULT_COUNT = 10_000

const { values } = parseArgs({
  options: {
    count: { type: 'string', short: 'n' },
    reset: { type: 'boolean' },
  },
})

const requestedCount = Number(values.count ?? DEFAULT_COUNT)

if (!Number.isFinite(requestedCount) || requestedCount < 1) {
  throw new Error(`--count must be a positive number, got "${values.count ?? ''}"`)
}

const count = Math.floor(requestedCount)

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
})

async function uniqueCodes(total: number): Promise<string[]> {
  const set = new Set<string>()
  while (set.size < total) {
    set.add(await generateShortCode(CODE_LENGTH))
  }
  return [...set]
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(LOADTEST_USER_PASSWORD, 10)

  const user = await prisma.user.upsert({
    where: { email: LOADTEST_USER_EMAIL },
    update: {},
    create: { email: LOADTEST_USER_EMAIL, passwordHash, emailVerifiedAt: new Date() },
    select: { id: true },
  })

  if (values.reset) {
    const { count: removed } = await prisma.url.deleteMany({ where: { userId: user.id } })
    console.log(`Reset: removed ${removed} existing load-test URL(s) for <${LOADTEST_USER_EMAIL}>.`)
  }

  const existing = await prisma.url.count({ where: { userId: user.id } })
  const toCreate = Math.max(0, count - existing)

  if (toCreate > 0) {
    console.log(`Generating ${toCreate} unique base62 code(s) of length ${CODE_LENGTH}…`)
    const codes = await uniqueCodes(toCreate)

    let inserted = 0
    for (const batch of chunk(codes, INSERT_CHUNK)) {
      const { count: n } = await prisma.url.createMany({
        data: batch.map((shortCode) => ({
          shortCode,
          originalUrl: `https://example.com/loadtest/${shortCode}`,
          userId: user.id,
        })),
        skipDuplicates: true,
      })
      inserted += n
      process.stdout.write(`\r  inserted ${inserted}/${toCreate}`)
    }
    process.stdout.write('\n')
  } else {
    console.log(`Dataset already holds ${existing} load-test URL(s) (>= requested ${count}); nothing to insert.`)
  }

  const rows = await prisma.url.findMany({
    where: { userId: user.id },
    select: { shortCode: true },
    orderBy: { createdAt: 'asc' },
    take: count,
  })

  const codes = rows.map((row) => row.shortCode)
  writeCodesFile(codes)

  console.log(
    `Load-test dataset ready: ${codes.length} short code(s) for <${LOADTEST_USER_EMAIL}> written to ${CODES_FILE}.`,
  )
}

main()
  .catch((error: unknown) => {
    console.error('Load-test seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
