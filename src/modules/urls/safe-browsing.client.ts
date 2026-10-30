import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { MetricsService } from '@/modules/metrics/metrics.service'

export const SAFE_BROWSING_SEARCH_URL = 'https://safebrowsing.googleapis.com/v5/urls:search'
const TIMEOUT_MS = 3_000

const THREAT_TYPE_NAMES: Record<number, string> = {
  1: 'MALWARE',
  2: 'SOCIAL_ENGINEERING',
  3: 'UNWANTED_SOFTWARE',
  4: 'POTENTIALLY_HARMFUL_APPLICATION',
}

/** Safe Browsing verdict for one URL. `unknown` when the lookup was skipped or failed. */
export type UrlVerdict = { status: 'safe' } | { status: 'unsafe'; threatTypes: string[] } | { status: 'unknown' }

type ProtoReader = { bytes: Uint8Array; pos: number }
type ProtoField = { field: number; value: number | Uint8Array }

function readVarint(reader: ProtoReader): number {
  let value = 0
  for (let shift = 0; shift < 64; shift += 7) {
    const byte = reader.bytes[reader.pos++]
    if (byte === undefined) throw new Error('Truncated protobuf varint')
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return value
  }
  throw new Error('Malformed protobuf varint')
}

function readFields(bytes: Uint8Array): ProtoField[] {
  const reader: ProtoReader = { bytes, pos: 0 }
  const fields: ProtoField[] = []
  while (reader.pos < bytes.length) {
    const tag = readVarint(reader)
    const field = Math.floor(tag / 8)
    const wireType = tag % 8
    if (wireType === 0) {
      fields.push({ field, value: readVarint(reader) })
    } else if (wireType === 2) {
      const end = readVarint(reader) + reader.pos
      if (end > bytes.length) throw new Error('Truncated protobuf field')
      fields.push({ field, value: bytes.subarray(reader.pos, end) })
      reader.pos = end
    } else if (wireType === 1 || wireType === 5) {
      reader.pos += wireType === 1 ? 8 : 4
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`)
    }
  }
  if (reader.pos > bytes.length) throw new Error('Truncated protobuf field')
  return fields
}

function readPackedVarints(bytes: Uint8Array): number[] {
  const reader: ProtoReader = { bytes, pos: 0 }
  const values: number[] = []
  while (reader.pos < bytes.length) values.push(readVarint(reader))
  return values
}

// urls:search answers in binary protobuf only (`$alt=json` is rejected with "Unsupported Output
// Format"). The response is small enough to decode by hand: SearchUrlsResponse { repeated ThreatUrl
// threats = 1 }, ThreatUrl { string url = 1; repeated ThreatType threat_types = 2 }. Returns null
// when nothing matched.
function decodeThreatTypes(body: Uint8Array): string[] | null {
  const threats = readFields(body).flatMap(({ field, value }) =>
    field === 1 && typeof value !== 'number' ? [value] : [],
  )
  if (threats.length === 0) return null

  const threatTypes = new Set<string>()
  for (const threat of threats) {
    for (const { field, value } of readFields(threat)) {
      if (field !== 2) continue
      const codes = typeof value === 'number' ? [value] : readPackedVarints(value)
      for (const code of codes) threatTypes.add(THREAT_TYPE_NAMES[code] ?? `THREAT_TYPE_${code}`)
    }
  }
  return [...threatTypes]
}

/** Google Safe Browsing v5 `urls:search`, turned off when `SAFE_BROWSING_API_KEY` is empty. */
@Injectable()
export class SafeBrowsingClient {
  private readonly logger = new Logger(SafeBrowsingClient.name)
  private readonly apiKey: string | undefined

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('shortener.safeBrowsingApiKey')
  }

  get enabled(): boolean {
    return this.apiKey !== undefined
  }

  /**
   * Looks `url` up. Never throws: gives `unknown` without an API key, on HTTP errors, timeouts and
   * malformed responses, so the caller decides what an unchecked URL means.
   */
  async lookup(url: string): Promise<UrlVerdict> {
    if (this.apiKey === undefined) return { status: 'unknown' }

    this.metrics.increment('safe_browsing_lookups_total')
    try {
      const response = await fetch(`${SAFE_BROWSING_SEARCH_URL}?${new URLSearchParams({ urls: url })}`, {
        headers: { 'X-Goog-Api-Key': this.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        // Errors are a binary google.rpc.Status as well; its message strings stay readable.
        const body = (await response.text())
          .replace(/[^\x20-\x7e]+/g, ' ')
          .trim()
          .slice(0, 300)
        return this.failed(`HTTP ${response.status}: ${body}`)
      }

      const threatTypes = decodeThreatTypes(new Uint8Array(await response.arrayBuffer()))
      if (threatTypes === null) return { status: 'safe' }

      this.metrics.increment('safe_browsing_flagged_total')
      return { status: 'unsafe', threatTypes }
    } catch (error) {
      return this.failed((error as Error).message)
    }
  }

  private failed(detail: string): UrlVerdict {
    this.metrics.increment('safe_browsing_lookup_errors_total')
    this.logger.warn(`Safe Browsing lookup failed: ${detail}`)
    return { status: 'unknown' }
  }
}
