import { API_PREFIX } from '@/common/api-prefix'

export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`

export const CREDENTIALS_THROTTLE = { default: { limit: 10, ttl: 60_000 } }
export const REFRESH_THROTTLE = { default: { limit: 120, ttl: 60_000 } }
