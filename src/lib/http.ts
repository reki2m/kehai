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

/**
 * Live snapshots:
 * - Dev: same-origin /live (Vite public/)
 * - Prod: raw.githubusercontent.com live-data branch (avoids Pages 10m CDN cache)
 */
const LIVE_DATA_RAW =
  'https://raw.githubusercontent.com/reki2m/kehai/live-data'

export function liveSnapshotUrl(pairId: string, timeframe: string): string {
  const bust = Date.now()
  if (import.meta.env.DEV) {
    const base = import.meta.env.BASE_URL || '/'
    return `${base}live/${pairId}_${timeframe}.json?t=${bust}`
  }
  return `${LIVE_DATA_RAW}/${pairId}_${timeframe}.json?t=${bust}`
}

export function liveNewsUrl(name: 'calendar' | 'headlines'): string {
  const bust = Date.now()
  if (import.meta.env.DEV) {
    const base = import.meta.env.BASE_URL || '/'
    return `${base}live/${name}.json?t=${bust}`
  }
  return `${LIVE_DATA_RAW}/${name}.json?t=${bust}`
}
