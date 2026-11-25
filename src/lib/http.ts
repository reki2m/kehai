/** Dev uses Vite proxy; production prefers same-origin /live snapshots. */

export function apiUrl(path: string): string {
  // path like /api/yahoo/v8/... or /api/ff/...
  if (import.meta.env.DEV) return path

  if (path.startsWith('/api/ff')) {
    const target = `https://nfs.faireconomy.media${path.replace(/^\/api\/ff/, '')}`
    return `https://corsproxy.io/?${encodeURIComponent(target)}`
  }
  if (path.startsWith('/api/investing-rss')) {
    const target = `https://www.investing.com${path.replace(/^\/api\/investing-rss/, '')}`
    return `https://corsproxy.io/?${encodeURIComponent(target)}`
  }
  // Yahoo is blocked in browser (403 via CORS relays). Use /live/*.json instead.
  return path
}

/** Same-origin live snapshot written by GitHub Actions. */
export function liveSnapshotUrl(pairId: string, timeframe: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const bust = Math.floor(Date.now() / 60_000) // cache ~1 min
  return `${base}live/${pairId}_${timeframe}.json?t=${bust}`
}
