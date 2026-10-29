import type { Params } from 'nestjs-pino'

import { clientIp } from '@/common/trusted-proxy'
import { env } from '@/config/env'

const isProduction = env.NODE_ENV === 'production'

export const loggerOptions: Params = {
  pinoHttp: {
    level: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    transport: isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-proxy-secret"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.jwt',
      ],
      censor: '[redacted]',
    },
    customProps: (req) => ({
      userId: req.user?.id ?? null,
      clientIp: clientIp(req),
    }),
  },
}
