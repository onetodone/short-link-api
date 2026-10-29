import { registerAs } from '@nestjs/config'

import { env } from '@/config/env'

export const mailConfig = registerAs('mail', () => ({
  appUrl: env.APP_URL,
  supportEmail: env.SUPPORT_EMAIL,
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Left undefined when unset so nodemailer enables implicit TLS for port 465.
    secure: env.SMTP_SECURE,
    requireTLS: env.SMTP_REQUIRE_TLS,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  },
  fromEmail: (env.SMTP_FROM_EMAIL ?? env.SMTP_USER) as string,
  fromName: env.SMTP_FROM_NAME,
}))
