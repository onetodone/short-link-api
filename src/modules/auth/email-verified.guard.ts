import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'

import { PrismaService } from '@/database/prisma.service'
import { AccountSuspendedException, EmailNotVerifiedException } from '@/modules/auth/auth.errors'

/**
 * Lets through only users with a confirmed email address and an account that isn't suspended; use
 * after `JwtAuthGuard`. Reads the account on every call rather than a token claim, so a confirmation
 * or a suspension applies to sessions already open.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  private readonly supportEmail: string

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.supportEmail = config.getOrThrow<string>('mail.supportEmail')
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<FastifyRequest>().user?.id
    if (!userId) {
      throw new UnauthorizedException('Authentication required')
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true, suspendedAt: true },
    })
    if (!user) {
      throw new UnauthorizedException('Account no longer exists')
    }
    if (user.suspendedAt) {
      throw new AccountSuspendedException(this.supportEmail)
    }
    if (!user.emailVerifiedAt) {
      throw new EmailNotVerifiedException()
    }
    return true
  }
}
