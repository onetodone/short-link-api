import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

import { PrismaService } from '@/database/prisma.service'
import { EmailNotVerifiedException } from '@/modules/auth/auth.errors'

/**
 * Lets through only users with a confirmed email address; use after `JwtAuthGuard`. Reads the
 * account on every call rather than a token claim, so a confirmation applies to sessions already open.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<FastifyRequest>().user?.id
    if (!userId) {
      throw new UnauthorizedException('Authentication required')
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } })
    if (!user) {
      throw new UnauthorizedException('Account no longer exists')
    }
    if (!user.emailVerifiedAt) {
      throw new EmailNotVerifiedException()
    }
    return true
  }
}
