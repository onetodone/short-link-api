import { describe, expect, it } from 'vitest'

import { destinationRejection } from '@/modules/urls/destination-rules'

const OWN = 'sho.rt'

const check = (url: string) => destinationRejection(new URL(url).href, OWN)

describe('destinationRejection', () => {
  it.each([
    'https://example.com/',
    'https://www.example.com/path?q=1',
    'http://sub.domain.co.uk/',
    'https://xn--e1afmkfd.xn--p1ai/',
  ])('allows %s', (url) => {
    expect(check(url)).toBeNull()
  })

  it.each(['https://bank.example.com@evil.com/', 'https://user:pass@example.com/', 'https://:secret@example.com/'])(
    'rejects credentials in %s',
    (url) => {
      expect(check(url)).toBe('CREDENTIALS_IN_URL')
    },
  )

  it.each([
    'http://127.0.0.1/',
    'http://8.8.8.8/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::1]/',
    'http://[2001:db8::1]:8080/',
    'http://8.8.8.8./',
  ])('rejects the IP-literal host %s', (url) => {
    expect(check(url)).toBe('IP_ADDRESS')
  })

  it.each([
    'http://localhost/',
    'http://localhost.:3000/',
    'http://api.localhost/',
    'http://intranet/',
    'http://printer.local/',
    'http://db.internal/',
    'http://router.home.arpa/',
    'http://site.test/',
  ])('rejects the local host %s', (url) => {
    expect(check(url)).toBe('LOCAL_HOST')
  })

  it.each(['http://sho.rt/abc1234', 'https://SHO.RT./x'])('rejects the service own domain in %s', (url) => {
    expect(check(url)).toBe('OWN_DOMAIN')
  })

  it.each(['https://bit.ly/x', 'https://BIT.LY./x', 'https://www.tinyurl.com/x', 'https://l.facebook.com/l.php?u=x'])(
    'rejects the shortener %s',
    (url) => {
      expect(check(url)).toBe('URL_SHORTENER')
    },
  )

  it('does not match a shortener name inside another domain', () => {
    expect(check('https://notbit.ly/x')).toBeNull()
    expect(check('https://bit.ly.example.com/x')).toBeNull()
  })
})
