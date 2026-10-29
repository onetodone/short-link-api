import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import type { FastifyRequest } from 'fastify'
import { LoggerModule } from 'nestjs-pino'

import { appConfig } from '@/config/app.config'
import { authConfig } from '@/config/auth.config'
import { cacheConfig } from '@/config/cache.config'
import { databaseConfig } from '@/config/database.config'
import { jwtConfig } from '@/config/jwt.config'
import { redisConfig } from '@/config/redis.config'
import { shortenerConfig } from '@/config/shortener.config'
import { validateEnv } from '@/config/env'
import { loggerOptions } from '@/common/logging/pino.config'
import { clientIp } from '@/common/trusted-proxy'
import { PrismaModule } from '@/database/prisma.module'
import { RedisModule } from '@/redis/redis.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { HealthModule } from '@/modules/health/health.module'
import { MetricsModule } from '@/modules/metrics/metrics.module'
import { UrlsModule } from '@/modules/urls/urls.module'
import { AppController } from '@/app.controller'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [appConfig, authConfig, databaseConfig, redisConfig, jwtConfig, cacheConfig, shortenerConfig],
    }),
    LoggerModule.forRoot(loggerOptions),
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('app.throttleTtl', 60_000),
            limit: config.get<number>('app.throttleLimit', 100),
          },
        ],
        getTracker: (req) => clientIp((req as FastifyRequest).raw),
      }),
    }),
    PrismaModule,
    RedisModule,
    MetricsModule,
    AuthModule,
    HealthModule,
    UrlsModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
