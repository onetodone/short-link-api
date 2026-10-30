import { SHORT_CODE_PATTERN } from '@/modules/urls/short-code.util'

/** The short code in `target`: a bare code or a short URL such as `https://s.example/aB3xK9p`. */
export function parseShortCode(target: string): string | null {
  const value = target.trim()
  if (SHORT_CODE_PATTERN.test(value)) {
    return value
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const code = segments.length === 1 ? segments[0] : undefined
  return code !== undefined && SHORT_CODE_PATTERN.test(code) ? code : null
}

export function isEmailTarget(target: string): boolean {
  return /^[^\s@/]+@[^\s@/]+$/.test(target.trim())
}
