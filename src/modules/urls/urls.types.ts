import type { UrlDisabledReason } from '@prisma-client'

export interface CreatedUrl {
  shortCode: string
  shortUrl: string
  originalUrl: string
  note: string | null
  createdAt: Date
  updatedAt: Date
}

export interface UrlSummary {
  shortCode: string
  shortUrl: string
  originalUrl: string
  note: string | null
  clicks: number
  disabled: boolean
  disabledReason: UrlDisabledReason | null
  createdAt: Date
  updatedAt: Date
}

export interface UrlList {
  items: UrlSummary[]
  total: number
  limit: number
  offset: number
}

export interface ListUrlsOptions {
  limit: number
  offset: number
}

export interface NewUrl {
  url: string
  note?: string | null
}

export interface UrlChanges {
  url?: string
  note?: string | null
}
