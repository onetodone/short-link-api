import {
  defineTemplate,
  html,
  type ResolvedBranding,
  type SafeHtml,
  type Template,
  type TemplateTexts,
} from '@onetodone/mailer'
import { z } from 'zod'

const shortUrl = z.url({ protocol: /^https?$/ })

function supportLink(branding: ResolvedBranding): SafeHtml {
  const email = branding.supportEmail
  return html`<a href="mailto:${email}" style="color:${branding.theme.primary};text-decoration:underline;">${email}</a>`
}

const linkDisabled = defineTemplate({
  name: 'linkDisabled',
  schema: z.strictObject({ shortUrl, reason: z.enum(['unsafe', 'manual']) }),
  messages: {
    en: {
      subject: 'Your short link was disabled',
      preheader: 'Visitors to {shortUrl} no longer reach its destination.',
      heading: 'Your short link was disabled',
      intro: 'We disabled your short link {shortUrl}. Visitors who open it see a notice instead of the destination.',
      unsafe:
        'Its destination was reported as unsafe. Point the link to another address in your dashboard and it will work again.',
      manual: "It doesn't follow the rules for using {companyName}.",
      help: 'If you think this is a mistake, write to us at {email}.',
    },
  },
  render: ({ props, ui, t, branding }) => ({
    subject: t('linkDisabled.subject'),
    preheader: t('linkDisabled.preheader', { shortUrl: props.shortUrl }),
    body: [
      ui.heading(t('linkDisabled.heading')),
      ui.paragraph(t('linkDisabled.intro', { shortUrl: props.shortUrl })),
      ui.paragraph(t(props.reason === 'unsafe' ? 'linkDisabled.unsafe' : 'linkDisabled.manual')),
      ui.divider(),
      ui.paragraph(t.html('linkDisabled.help', { email: supportLink(branding) })),
    ],
  }),
})

const linkEnabled = defineTemplate({
  name: 'linkEnabled',
  schema: z.strictObject({ shortUrl }),
  messages: {
    en: {
      subject: 'Your short link works again',
      preheader: '{shortUrl} takes visitors to its destination again.',
      heading: 'Your short link works again',
      intro: 'Your short link {shortUrl} is enabled again and takes visitors to its destination.',
    },
  },
  render: ({ props, ui, t }) => ({
    subject: t('linkEnabled.subject'),
    preheader: t('linkEnabled.preheader', { shortUrl: props.shortUrl }),
    body: [ui.heading(t('linkEnabled.heading')), ui.paragraph(t('linkEnabled.intro', { shortUrl: props.shortUrl }))],
  }),
})

const accountSuspended = defineTemplate({
  name: 'accountSuspended',
  schema: z.strictObject({}),
  messages: {
    en: {
      subject: 'Your account is suspended',
      preheader: 'Your {companyName} account is suspended.',
      heading: 'Your account is suspended',
      intro:
        "We suspended your {companyName} account. You can't sign in, and your short links no longer take visitors to their destinations.",
      help: 'To find out why, or if you think this is a mistake, write to us at {email}.',
    },
  },
  render: ({ ui, t, branding }) => ({
    subject: t('accountSuspended.subject'),
    preheader: t('accountSuspended.preheader'),
    body: [
      ui.heading(t('accountSuspended.heading')),
      ui.paragraph(t('accountSuspended.intro')),
      ui.divider(),
      ui.paragraph(t.html('accountSuspended.help', { email: supportLink(branding) })),
    ],
  }),
})

const accountRestored = defineTemplate({
  name: 'accountRestored',
  schema: z.strictObject({}),
  messages: {
    en: {
      subject: 'Your account is restored',
      preheader: 'You can sign in to your {companyName} account again.',
      heading: 'Your account is restored',
      intro:
        'Your {companyName} account is no longer suspended. You can sign in again, and the short links disabled by the suspension work again.',
      button: 'Sign in',
    },
  },
  render: ({ ui, t, branding }) => ({
    subject: t('accountRestored.subject'),
    preheader: t('accountRestored.preheader'),
    body: [
      ui.heading(t('accountRestored.heading')),
      ui.paragraph(t('accountRestored.intro')),
      ui.button(t('accountRestored.button'), branding.appUrl),
    ],
  }),
})

export const MAIL_TEMPLATES = { linkDisabled, linkEnabled, accountSuspended, accountRestored } satisfies Record<
  string,
  Template<string, unknown, unknown, TemplateTexts>
>

export type MailTemplates = typeof MAIL_TEMPLATES
