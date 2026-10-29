import { describe, expect, it } from 'vitest'

import { loginSchema } from '@/modules/auth/dto/login.dto'
import { registerSchema } from '@/modules/auth/dto/register.dto'
import { createUrlSchema } from '@/modules/urls/dto/create-url.dto'
import { listUrlsSchema } from '@/modules/urls/dto/list-urls.dto'

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
