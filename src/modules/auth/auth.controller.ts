import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { API_PREFIX } from '@/common/api-prefix'
import { parseDurationSeconds } from '@/common/duration.util'
import {
  CREDENTIALS_THROTTLE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_THROTTLE,
} from '@/modules/auth/auth.constants'
import { AuthService } from '@/modules/auth/auth.service'
import type { AuthProfile, AuthResponse, AuthResult, AuthUser, RequestContext } from '@/modules/auth/auth.types'
import { CurrentUser } from '@/modules/auth/current-user.decorator'
import { ForgotPasswordDto } from '@/modules/auth/dto/forgot-password.dto'
import { LoginDto } from '@/modules/auth/dto/login.dto'
import { RegisterDto } from '@/modules/auth/dto/register.dto'
import { ResetPasswordDto } from '@/modules/auth/dto/reset-password.dto'
import { VerifyEmailDto } from '@/modules/auth/dto/verify-email.dto'
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard'
import { UserAgent } from '@/modules/auth/user-agent.decorator'
import { UserIp } from '@/modules/auth/user-ip.decorator'
import { VerificationService } from '@/modules/auth/verification.service'

const DEFAULT_REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

@Controller(`${API_PREFIX}/auth`)
export class AuthController {
  private readonly cookieSecure: boolean
  private readonly refreshMaxAgeSeconds: number

  constructor(
    private readonly auth: AuthService,
    private readonly verification: VerificationService,
    config: ConfigService,
  ) {
    this.cookieSecure = config.get<string>('app.nodeEnv', 'production') === 'production'
    this.refreshMaxAgeSeconds = parseDurationSeconds(
      config.get<string>('jwt.refreshExpiresIn', '7d'),
      DEFAULT_REFRESH_MAX_AGE_SECONDS,
    )
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(CREDENTIALS_THROTTLE)
  async register(
    @Body() dto: RegisterDto,
    @UserIp() ip: string | undefined,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const result = await this.auth.register(dto.email, dto.password, { ip, userAgent })
    return this.finish(reply, result)
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIALS_THROTTLE)
  async login(
    @Body() dto: LoginDto,
    @UserIp() ip: string | undefined,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const result = await this.auth.login(dto.email, dto.password, { ip, userAgent })
    return this.finish(reply, result)
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(REFRESH_THROTTLE)
  async refresh(
    @Req() request: FastifyRequest,
    @UserIp() ip: string | undefined,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const token = request.cookies?.[REFRESH_COOKIE]
    if (!token) {
      throw new UnauthorizedException('Missing refresh token')
    }

    const ctx: RequestContext = { ip, userAgent }
    const result = await this.auth.refresh(token, ctx)
    return this.finish(reply, result)
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser('sessionId') sessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(sessionId)
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@CurrentUser('id') userId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logoutAll(userId)
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('id') userId: string): Promise<AuthProfile> {
    return this.auth.profile(userId)
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIALS_THROTTLE)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ user: AuthUser }> {
    return { user: await this.verification.verifyEmail(dto.token) }
  }

  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle(CREDENTIALS_THROTTLE)
  resendVerification(@CurrentUser('id') userId: string): Promise<void> {
    return this.verification.resendVerification(userId)
  }

  @Post('password/forgot')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  forgotPassword(@Body() dto: ForgotPasswordDto): void {
    this.verification.requestPasswordReset(dto.email)
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CREDENTIALS_THROTTLE)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @UserIp() ip: string | undefined,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.verification.resetPassword(dto.token, dto.password, { ip, userAgent })
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
  }

  private finish(reply: FastifyReply, result: AuthResult): AuthResponse {
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: this.refreshMaxAgeSeconds,
    })

    return {
      user: result.user,
      accessToken: result.accessToken,
    }
  }
}
