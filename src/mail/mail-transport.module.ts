import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { smtpTransport, type SmtpTransportOptions } from '@onetodone/mailer/smtp'

import { MAIL_TRANSPORT } from '@/mail/mail.constants'

@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        smtpTransport({ ...config.getOrThrow<SmtpTransportOptions>('mail.smtp'), pool: true }),
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailTransportModule {}
