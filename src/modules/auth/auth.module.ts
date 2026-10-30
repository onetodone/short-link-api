import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'

import { AuthController } from '@/modules/auth/auth.controller'
import { AuthService } from '@/modules/auth/auth.service'
import { CaptchaService } from '@/modules/auth/captcha.service'
import { EmailCooldownService } from '@/modules/auth/email-cooldown.service'
import { EmailVerifiedGuard } from '@/modules/auth/email-verified.guard'
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard'
import { SessionCleanupService } from '@/modules/auth/session-cleanup.service'
import { TurnstileClient } from '@/modules/auth/turnstile.client'
import { VerificationService } from '@/modules/auth/verification.service'

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    VerificationService,
    EmailCooldownService,
    JwtAuthGuard,
    EmailVerifiedGuard,
    SessionCleanupService,
    TurnstileClient,
    CaptchaService,
  ],
  exports: [JwtAuthGuard, EmailVerifiedGuard, JwtModule, VerificationService, TurnstileClient],
})
export class AuthModule {}
