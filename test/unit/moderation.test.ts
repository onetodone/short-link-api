import { describe, expect, it } from 'vitest'

import { parseModerationCommand } from '@/cli/moderation-commands'
import { isEmailTarget, parseShortCode } from '@/modules/moderation/moderation-target'
import { ModerationError } from '@/modules/moderation/moderation.service'

describe('parseShortCode', () => {
  it.each([
    ['aB3xK9p', 'aB3xK9p'],
    ['  aB3xK9p ', 'aB3xK9p'],
    ['https://s.example/aB3xK9p', 'aB3xK9p'],
    ['http://localhost:3000/aB3xK9p/', 'aB3xK9p'],
    ['https://s.example/aB3xK9p?utm=x#top', 'aB3xK9p'],
  ])('reads %s as %s', (target, code) => {
    expect(parseShortCode(target)).toBe(code)
  })

  it.each(['abc', 'a-b-c-d', 'https://s.example/', 'https://s.example/a/aB3xK9p', 'ftp://s.example/aB3xK9p', ''])(
    'finds no code in "%s"',
    (target) => {
      expect(parseShortCode(target)).toBeNull()
    },
  )
})

describe('isEmailTarget', () => {
  it('tells an address from a code or a URL', () => {
    expect(isEmailTarget('owner@example.com')).toBe(true)
    expect(isEmailTarget('aB3xK9p')).toBe(false)
    expect(isEmailTarget('https://user@s.example/aB3xK9p')).toBe(false)
  })
})

describe('parseModerationCommand', () => {
  it('reads the command, the target and the flags', () => {
    expect(parseModerationCommand(['link:disable', 'aB3xK9p', '--owner', '--unsafe'])).toEqual({
      command: 'link:disable',
      target: 'aB3xK9p',
      owner: true,
      unsafe: true,
    })
    expect(parseModerationCommand(['user:suspend', 'owner@example.com'])).toEqual({
      command: 'user:suspend',
      target: 'owner@example.com',
      owner: false,
      unsafe: false,
    })
  })

  it.each([
    [[]],
    [['link:disable']],
    [['link:disable', 'a', 'b']],
    [['link:delete', 'aB3xK9p']],
    [['link:enable', 'aB3xK9p', '--owner']],
    [['user:suspend', 'owner@example.com', '--unsafe']],
    [['link:disable', 'aB3xK9p', '--force']],
  ])('rejects %j with the usage', (argv) => {
    expect(() => parseModerationCommand(argv)).toThrow(ModerationError)
    expect(() => parseModerationCommand(argv)).toThrow('Usage:')
  })
})
