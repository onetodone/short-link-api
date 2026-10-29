import { Module } from '@nestjs/common'

import { AccountController } from '@/modules/account/account.controller'
import { AccountService } from '@/modules/account/account.service'
import { AuthModule } from '@/modules/auth/auth.module'
import { UrlsModule } from '@/modules/urls/urls.module'

@Module({
  imports: [AuthModule, UrlsModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
