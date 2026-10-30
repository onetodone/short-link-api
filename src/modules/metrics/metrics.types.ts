export type CounterName =
  | 'cache_hits_total'
  | 'cache_misses_total'
  | 'urls_created_total'
  | 'http_redirects_total'
  | 'http_redirects_bot_total'
  | 'http_redirects_disabled_total'
  | 'clicks_flushed_total'
  | 'clicks_flush_errors_total'

export interface CounterMeta {
  name: CounterName
  help: string
}
