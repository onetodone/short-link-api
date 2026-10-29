import { Global, Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { MailTransport } from '@onetodone/mailer'
import { MailerModule } from '@onetodone/mailer/nestjs'

import { MAIL_TRANSPORT } from '@/mail/mail.constants'
import { MailTransportModule } from '@/mail/mail-transport.module'
import { MailService } from '@/mail/mail.service'

const PRODUCT_NAME = 'Short Link'

@Global()
@Module({
  imports: [
    MailerModule.forRootAsync({
      isGlobal: false,
      imports: [MailTransportModule],
      inject: [ConfigService, MAIL_TRANSPORT],
      useFactory: (config: ConfigService, transport: MailTransport) => {
        const logger = new Logger(MailService.name)
        const fromEmail = config.getOrThrow<string>('mail.fromEmail')
        const fromName = config.get<string>('mail.fromName')

        return {
          transport,
          from: fromName ? { name: fromName, address: fromEmail } : fromEmail,
          branding: {
            companyName: PRODUCT_NAME,
            appUrl: config.getOrThrow<string>('mail.appUrl'),
            supportEmail: config.getOrThrow<string>('mail.supportEmail'),
            footerText: 'This is an automated message, please do not reply.',
          },
          onSent: ({ template, result, durationMs }) => {
            logger.log(`Email "${template}" sent (${result.messageId}, ${Math.round(durationMs)}ms)`)
          },
          onError: ({ template, error }) => {
            logger.error(`Email "${template}" failed: ${(error as Error).message}`)
          },
        }
      },
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
