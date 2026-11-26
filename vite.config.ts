import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages project site: https://reki2m.github.io/kehai/
  base: process.env.GITHUB_PAGES === '1' ? '/kehai/' : '/',
  server: {
    proxy: {
      // Live FX rates — Yahoo Finance chart API
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
      },
      // Economic calendar + speeches (Forex Factory via faireconomy)
      '/api/ff': {
        target: 'https://nfs.faireconomy.media',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ff/, ''),
      },
      // FX headline RSS (EN fallback)
      '/api/investing-rss': {
        target: 'https://www.investing.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/investing-rss/, ''),
      },
      // 日本語・外為ニュース RSS
      '/api/investing-jp': {
        target: 'https://jp.investing.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/investing-jp/, ''),
      },
    },
  },
})
