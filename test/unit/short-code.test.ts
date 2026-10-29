import { describe, expect, it } from 'vitest'

import { generateShortCode, SHORT_CODE_PATTERN } from '@/modules/urls/short-code.util'

describe('generateShortCode', () => {
  it('returns a base62 code of the requested length', async () => {
    for (const length of [4, 7, 32]) {
      const code = await generateShortCode(length)
      expect(code).toHaveLength(length)
      expect(code).toMatch(/^[0-9A-Za-z]+$/)
    }
  })

  it('produces distinct codes', async () => {
    const codes = await Promise.all(Array.from({ length: 200 }, () => generateShortCode(7)))
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('SHORT_CODE_PATTERN', () => {
  it.each(['abcd', 'aB3xK9p', 'Z'.repeat(32)])('accepts %s', (code) => {
    expect(SHORT_CODE_PATTERN.test(code)).toBe(true)
  })

  it.each(['abc', 'Z'.repeat(33), 'ab-cd', 'ab.cd', 'abcd/', ''])('rejects "%s"', (code) => {
    expect(SHORT_CODE_PATTERN.test(code)).toBe(false)
  })
})
