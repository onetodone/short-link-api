import { Module } from '@nestjs/common'

import { ModerationService } from '@/modules/moderation/moderation.service'

@Module({
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
