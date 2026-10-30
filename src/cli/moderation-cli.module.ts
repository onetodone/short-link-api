import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { appConfig } from '@/config/app.config'
import { databaseConfig } from '@/config/database.config'
import { validateEnv } from '@/config/env'
import { mailConfig } from '@/config/mail.config'
import { redisConfig } from '@/config/redis.config'
import { shortenerConfig } from '@/config/shortener.config'
import { PrismaModule } from '@/database/prisma.module'
import { MailModule } from '@/mail/mail.module'
import { ModerationModule } from '@/modules/moderation/moderation.module'
import { RedisModule } from '@/redis/redis.module'

/** The parts of the application the moderation commands need, without the HTTP server or timers. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [appConfig, databaseConfig, redisConfig, shortenerConfig, mailConfig],
    }),
    PrismaModule,
    RedisModule,
    MailModule,
    ModerationModule,
  ],
})
export class ModerationCliModule {}
