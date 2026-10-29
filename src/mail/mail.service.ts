import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MailerService } from '@onetodone/mailer/nestjs'

export const EMAIL_VERIFY_TTL_MINUTES = 24 * 60
export const PASSWORD_RESET_TTL_MINUTES = 60
export const EMAIL_CHANGE_TTL_MINUTES = 24 * 60

/**
 * Account emails. Every method hands the email to the transport in the background and returns at
 * once, so no response waits on SMTP; a failed delivery is logged and never thrown.
 */
@Injectable()
export class MailService {
  private readonly appUrl: string

  constructor(
    private readonly mailer: MailerService,
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

  private link(path: string, token: string): string {
    const url = new URL(`${this.appUrl}${path}`)
    url.searchParams.set('token', token)
    return url.toString()
  }

  private dispatch(sending: Promise<unknown>): void {
    // onError in MailModule has already logged the failure.
    sending.catch(() => undefined)
  }
}
