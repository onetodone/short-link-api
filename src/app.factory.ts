import fastifyCookie from '@fastify/cookie'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'
import { ZodValidationPipe } from 'nestjs-zod'

import { AppModule } from '@/app.module'
import { trustProxy } from '@/common/trusted-proxy'

/** Builds the fully configured application without binding a port. */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy, bodyLimit: 1_048_576 }),
    { bufferLogs: true },
  )

  app.useLogger(app.get(Logger))
  app.flushLogs()

  app.useGlobalPipes(new ZodValidationPipe())

  const config = app.get(ConfigService)
  const corsOrigin = config.get<string>('app.corsOrigin', '*')
  const cookieSecret = config.get<string>('app.cookieSecret')

  await app.register(fastifyCookie, cookieSecret ? { secret: cookieSecret } : {})

  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((entry) => entry.trim()),
    credentials: true,
  })

  app.enableShutdownHooks()

  return app
}
