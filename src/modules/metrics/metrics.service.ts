import { Injectable } from '@nestjs/common'

import type { CounterMeta, CounterName } from '@/modules/metrics/metrics.types'

const COUNTERS: readonly CounterMeta[] = [
  { name: 'cache_hits_total', help: 'Short-code resolutions served from the Redis cache (incl. negative hits)' },
  { name: 'cache_misses_total', help: 'Short-code resolutions that missed the Redis cache and hit Postgres' },
  { name: 'urls_created_total', help: 'Short Links created via POST /api/v1/urls' },
  { name: 'http_redirects_total', help: 'Successful redirects served by GET /:shortCode' },
  {
    name: 'http_redirects_bot_total',
    help: 'Redirects not counted as clicks: bots, link-preview crawlers, prefetches and HEAD requests',
  },
  {
    name: 'http_redirects_disabled_total',
    help: 'Requests for disabled links, sent to the link-disabled page and not counted as clicks',
  },
  { name: 'clicks_flushed_total', help: 'Buffered clicks reconciled into Postgres by the flush cycle' },
  { name: 'clicks_flush_errors_total', help: 'Click-buffer flush cycles that failed and were re-buffered' },
] as const

@Injectable()
export class MetricsService {
  private readonly startedAt = Date.now()
  private readonly counters = new Map<CounterName, number>(COUNTERS.map(({ name }) => [name, 0]))

  increment(name: CounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  render(): string {
    const lines: string[] = []

    for (const { name, help } of COUNTERS) {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} counter`)
      lines.push(`${name} ${this.counters.get(name) ?? 0}`)
    }

    const uptimeSeconds = (Date.now() - this.startedAt) / 1000
    lines.push('# HELP process_uptime_seconds Seconds since the metrics registry was initialised')
    lines.push('# TYPE process_uptime_seconds gauge')
    lines.push(`process_uptime_seconds ${uptimeSeconds.toFixed(3)}`)

    return `${lines.join('\n')}\n`
  }
}
