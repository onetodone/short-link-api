import type { AuthUser } from '@/modules/auth/auth.types'
import type { Prisma } from '@prisma-client'

export const BCRYPT_COST = 12

export const USER_SELECT = { id: true, email: true, emailVerifiedAt: true } satisfies Prisma.UserSelect

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>

export function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, emailVerified: row.emailVerifiedAt !== null }
}
