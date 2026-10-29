import { Body, Controller, Delete, HttpCode, HttpStatus, Patch, Post, Res, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'

import { API_PREFIX } from '@/common/api-prefix'
import { AccountService } from '@/modules/account/account.service'
import { ChangeEmailDto } from '@/modules/account/dto/change-email.dto'
import { ChangePasswordDto } from '@/modules/account/dto/change-password.dto'
import { ConfirmEmailDto } from '@/modules/account/dto/confirm-email.dto'
import { DeleteAccountDto } from '@/modules/account/dto/delete-account.dto'
import { CREDENTIALS_THROTTLE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '@/modules/auth/auth.constants'
import type { AuthPrincipal, AuthUser } from '@/modules/auth/auth.types'
import { CurrentUser } from '@/modules/auth/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard'
import { UserIp } from '@/modules/auth/user-ip.decorator'
import { VerificationService } from '@/modules/auth/verification.service'

@Controller(`${API_PREFIX}/auth`)
@Throttle(CREDENTIALS_THROTTLE)
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly verification: VerificationService,
  ) {}

  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: ChangePasswordDto,
    @UserIp() ip: string | undefined,
  ): Promise<void> {
    return this.account.changePassword(principal.id, principal.sessionId, dto.currentPassword, dto.newPassword, {
      ip,
    })
  }

  @Post('me/email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  requestEmailChange(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangeEmailDto,
    @UserIp() ip: string | undefined,
  ): Promise<void> {
    return this.account.requestEmailChange(userId, dto.newEmail, dto.password, { ip })
  }

  @Post('email/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmEmailChange(@Body() dto: ConfirmEmailDto): Promise<{ user: AuthUser }> {
    return { user: await this.verification.confirmEmailChange(dto.token) }
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @CurrentUser('id') userId: string,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.account.deleteAccount(userId, dto.password)
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
  }
}
