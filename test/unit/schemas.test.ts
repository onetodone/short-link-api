import { describe, expect, it } from 'vitest'

import { changeEmailSchema } from '@/modules/account/dto/change-email.dto'
import { changePasswordSchema } from '@/modules/account/dto/change-password.dto'
import { deleteAccountSchema } from '@/modules/account/dto/delete-account.dto'
import { forgotPasswordSchema } from '@/modules/auth/dto/forgot-password.dto'
import { loginSchema } from '@/modules/auth/dto/login.dto'
import { registerSchema } from '@/modules/auth/dto/register.dto'
import { resetPasswordSchema } from '@/modules/auth/dto/reset-password.dto'
import { verifyEmailSchema } from '@/modules/auth/dto/verify-email.dto'
import { createUrlSchema } from '@/modules/urls/dto/create-url.dto'
import { listUrlsSchema } from '@/modules/urls/dto/list-urls.dto'
import { updateUrlSchema } from '@/modules/urls/dto/update-url.dto'

describe('createUrlSchema', () => {
  it('normalises the URL', () => {
    expect(createUrlSchema.parse({ url: '  HTTPS://Example.COM/A B  ' })).toEqual({ url: 'https://example.com/A%20B' })
  })

  it.each(['ftp://example.com', 'javascript:alert(1)', 'example.com', '', `https://e.com/${'a'.repeat(2048)}`])(
    'rejects "%s"',
    (url) => {
      expect(createUrlSchema.safeParse({ url }).success).toBe(false)
    },
  )

  it('trims the note and treats a blank one as none', () => {
    expect(createUrlSchema.parse({ url: 'https://e.com', note: '  launch  ' }).note).toBe('launch')
    expect(createUrlSchema.parse({ url: 'https://e.com', note: '   ' }).note).toBeNull()
    expect(createUrlSchema.parse({ url: 'https://e.com' }).note).toBeUndefined()
  })

  it.each(['x'.repeat(201), 42])('rejects the note %#', (note) => {
    expect(createUrlSchema.safeParse({ url: 'https://e.com', note }).success).toBe(false)
  })
})

describe('updateUrlSchema', () => {
  it('accepts the URL, the note or both', () => {
    expect(updateUrlSchema.parse({ url: 'https://e.com' })).toEqual({ url: 'https://e.com/' })
    expect(updateUrlSchema.parse({ note: 'x' })).toEqual({ note: 'x' })
    expect(updateUrlSchema.parse({ note: null })).toEqual({ note: null })
    expect(updateUrlSchema.parse({ url: 'https://e.com', note: '' })).toEqual({ url: 'https://e.com/', note: null })
  })

  it('requires at least one field', () => {
    expect(updateUrlSchema.safeParse({}).success).toBe(false)
  })
})

describe('registerSchema', () => {
  it('trims and lowercases the email', () => {
    expect(registerSchema.parse({ email: ' User@Example.COM ', password: 'password1' }).email).toBe('user@example.com')
  })

  it.each([
    ['short', 'password'],
    ['x'.repeat(129), 'password'],
  ])('rejects a password of %#', (password) => {
    expect(registerSchema.safeParse({ email: 'a@b.co', password }).success).toBe(false)
  })

  it('rejects an invalid email', () => {
    expect(registerSchema.safeParse({ email: 'not-an-email', password: 'password1' }).success).toBe(false)
  })
})

describe('loginSchema', () => {
  it('lowercases the email and accepts any non-empty password', () => {
    expect(loginSchema.parse({ email: 'A@B.CO', password: 'x' })).toEqual({ email: 'a@b.co', password: 'x' })
  })
})

describe('listUrlsSchema', () => {
  it('applies defaults and coerces query strings', () => {
    expect(listUrlsSchema.parse({})).toEqual({ limit: 20, offset: 0 })
    expect(listUrlsSchema.parse({ limit: '5', offset: '10' })).toEqual({ limit: 5, offset: 10 })
  })

  it.each([{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { limit: '1.5' }])('rejects %o', (query) => {
    expect(listUrlsSchema.safeParse(query).success).toBe(false)
  })
})

describe('account email schemas', () => {
  it('normalises the email of a reset request', () => {
    expect(forgotPasswordSchema.parse({ email: ' A@B.CO ' })).toEqual({ email: 'a@b.co' })
  })

  it('requires a token of sane length', () => {
    expect(verifyEmailSchema.safeParse({ token: 'abc' }).success).toBe(true)
    expect(verifyEmailSchema.safeParse({ token: '' }).success).toBe(false)
    expect(verifyEmailSchema.safeParse({ token: 'x'.repeat(257) }).success).toBe(false)
  })

  it('holds a reset password to the registration rules', () => {
    expect(resetPasswordSchema.safeParse({ token: 'abc', password: 'password1' }).success).toBe(true)
    expect(resetPasswordSchema.safeParse({ token: 'abc', password: 'short' }).success).toBe(false)
    expect(resetPasswordSchema.safeParse({ token: 'abc', password: 'x'.repeat(129) }).success).toBe(false)
  })
})

describe('account management schemas', () => {
  it('holds a changed password to the registration rules and requires the current one', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'password1' }).success).toBe(true)
    expect(changePasswordSchema.safeParse({ currentPassword: '', newPassword: 'password1' }).success).toBe(false)
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success).toBe(false)
    expect(changePasswordSchema.safeParse({ newPassword: 'password1' }).success).toBe(false)
  })

  it('normalises the new email and requires the password', () => {
    expect(changeEmailSchema.parse({ newEmail: ' A@B.CO ', password: 'x' })).toEqual({
      newEmail: 'a@b.co',
      password: 'x',
    })
    expect(changeEmailSchema.safeParse({ newEmail: 'not-an-email', password: 'x' }).success).toBe(false)
    expect(changeEmailSchema.safeParse({ newEmail: 'a@b.co' }).success).toBe(false)
  })

  it('requires a password of sane length to delete the account', () => {
    expect(deleteAccountSchema.safeParse({ password: 'x' }).success).toBe(true)
    expect(deleteAccountSchema.safeParse({ password: '' }).success).toBe(false)
    expect(deleteAccountSchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(false)
  })
})
