import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

import { PrismaClient } from './generated/client'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — cannot seed the database')
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
})

const DEMO_USER_EMAIL = 'demo@user.loc'
const DEMO_USER_PASSWORD = 'password123'

const DEMO_URLS: { shortCode: string; originalUrl: string }[] = [
  { shortCode: 'nestjs0', originalUrl: 'https://docs.nestjs.com/' },
  { shortCode: 'fastfy0', originalUrl: 'https://fastify.dev/docs/latest/' },
  { shortCode: 'prisma0', originalUrl: 'https://www.prisma.io/docs' },
  { shortCode: 'redis00', originalUrl: 'https://redis.io/docs/latest/' },
]

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_USER_PASSWORD, 10)

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: { email: DEMO_USER_EMAIL, passwordHash, emailVerifiedAt: new Date() },
  })

  for (const entry of DEMO_URLS) {
    await prisma.url.upsert({
      where: { shortCode: entry.shortCode },
      update: { originalUrl: entry.originalUrl },
      create: { ...entry, userId: user.id },
    })
  }

  const total = await prisma.url.count()
  console.log(
    `Seed complete: user <${user.email}> (password: ${DEMO_USER_PASSWORD}), ${DEMO_URLS.length} demo URLs, ${total} URLs total.`,
  )
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
