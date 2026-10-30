import { BeforeApplicationShutdown, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MailerService } from '@onetodone/mailer/nestjs'

import type { MailTemplates } from '@/mail/templates'

export const EMAIL_VERIFY_TTL_MINUTES = 24 * 60
export const PASSWORD_RESET_TTL_MINUTES = 60
export const EMAIL_CHANGE_TTL_MINUTES = 24 * 60

/**
 * Account emails. Every method hands the email to the transport in the background and returns at
 * once, so no response waits on SMTP; a failed delivery is logged and never thrown. Emails still
 * sending when the application closes are awaited before the transport shuts down.
 */
@Injectable()
export class MailService implements BeforeApplicationShutdown {
  private readonly appUrl: string
  private readonly sending = new Set<Promise<unknown>>()

  constructor(
    private readonly mailer: MailerService<MailTemplates>,
    config: ConfigService,
  ) {
    this.appUrl = config.getOrThrow<string>('mail.appUrl')
  }

  sendEmailVerification(to: string, token: string): void {
    this.dispatch(
      this.mailer.send('verifyEmail', {
        to,
        props: { verifyUrl: this.link('/verify-email', token), expiresInMinutes: EMAIL_VERIFY_TTL_MINUTES },
      }),
    )
  }

  sendPasswordReset(to: string, token: string): void {
    this.dispatch(
      this.mailer.send('resetPassword', {
        to,
        props: { resetUrl: this.link('/reset-password', token), expiresInMinutes: PASSWORD_RESET_TTL_MINUTES },
      }),
    )
  }

  sendPasswordChanged(to: string, details: { changedAt: Date; ip?: string }): void {
    this.dispatch(this.mailer.send('passwordChanged', { to, props: details }))
  }

  sendEmailChangeVerification(to: string, token: string): void {
    this.dispatch(
      this.mailer.send('verifyEmailChange', {
        to,
        props: { verifyUrl: this.link('/confirm-email', token), expiresInMinutes: EMAIL_CHANGE_TTL_MINUTES },
      }),
    )
  }

  sendEmailChangeRequested(to: string, details: { newEmail: string; requestedAt: Date; ip?: string }): void {
    this.dispatch(this.mailer.send('emailChangeRequested', { to, props: details }))
  }

  sendEmailChanged(to: string, details: { newEmail: string; changedAt: Date }): void {
    this.dispatch(this.mailer.send('emailChanged', { to, props: details }))
  }

  sendAccountDeleted(to: string): void {
    this.dispatch(this.mailer.send('accountDeleted', { to, props: {} }))
  }

  sendLinkDisabled(to: string, details: { shortUrl: string; reason: 'unsafe' | 'manual' }): void {
    this.dispatch(this.mailer.send('linkDisabled', { to, props: details }))
  }

  sendLinkEnabled(to: string, details: { shortUrl: string }): void {
    this.dispatch(this.mailer.send('linkEnabled', { to, props: details }))
  }

  sendAccountSuspended(to: string): void {
    this.dispatch(this.mailer.send('accountSuspended', { to, props: {} }))
  }

  sendAccountRestored(to: string): void {
    this.dispatch(this.mailer.send('accountRestored', { to, props: {} }))
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.sending)
  }

  private link(path: string, token: string): string {
    const url = new URL(`${this.appUrl}${path}`)
    url.searchParams.set('token', token)
    return url.toString()
  }

  private dispatch(sending: Promise<unknown>): void {
    // onError in MailModule has already logged the failure.
    const settled = sending.catch(() => undefined).finally(() => this.sending.delete(settled))
    this.sending.add(settled)
  }
}
