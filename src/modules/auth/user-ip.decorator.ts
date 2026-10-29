import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

import { clientIp } from '@/common/trusted-proxy'

export const UserIp = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<FastifyRequest>()
  return clientIp(request.raw) || undefined
})
