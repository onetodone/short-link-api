import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { ModerationModule } from '@/modules/moderation/moderation.module'
import { ClicksService } from '@/modules/urls/clicks.service'
import { CreateQuotaService } from '@/modules/urls/create-quota.service'
import { DestinationChecksService } from '@/modules/urls/destination-checks.service'
import { RedirectController } from '@/modules/urls/redirect.controller'
import { SafeBrowsingClient } from '@/modules/urls/safe-browsing.client'
import { UrlsController } from '@/modules/urls/urls.controller'
import { UrlsService } from '@/modules/urls/urls.service'

@Module({
  imports: [AuthModule, ModerationModule],
  controllers: [UrlsController, RedirectController],
  providers: [UrlsService, ClicksService, CreateQuotaService, SafeBrowsingClient, DestinationChecksService],
  exports: [UrlsService, CreateQuotaService],
})
export class UrlsModule {}
