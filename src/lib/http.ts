/** Dev uses Vite proxy; production (GitHub Pages) uses a CORS relay. */

export function apiUrl(path: string): string {
  // path like /api/yahoo/v8/... or /api/ff/...
  if (import.meta.env.DEV) return path

  if (path.startsWith('/api/yahoo')) {
    const target = `https://query1.finance.yahoo.com${path.replace(/^\/api\/yahoo/, '')}`
    return `https://corsproxy.io/?${encodeURIComponent(target)}`
  }
  if (path.startsWith('/api/ff')) {
    const target = `https://nfs.faireconomy.media${path.replace(/^\/api\/ff/, '')}`
    return `https://corsproxy.io/?${encodeURIComponent(target)}`
  }
  if (path.startsWith('/api/investing-rss')) {
    const target = `https://www.investing.com${path.replace(/^\/api\/investing-rss/, '')}`
    return `https://corsproxy.io/?${encodeURIComponent(target)}`
  }
  return path
}
