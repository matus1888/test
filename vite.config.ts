import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages: для project site нужен base '/<repo>/', для user site — '/'.
// Определяется автоматически из GITHUB_REPOSITORY в CI, локально — '/'.
// Ручное переопределение: BASE_PATH=/my-repo/ bun run build
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base =
  process.env.BASE_PATH ??
  (repo && !repo.endsWith('.github.io') ? `/${repo}/` : '/')

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    proxy: {
      // Fallback для обхода CORS: fetch('/bybit/v5/...') -> https://api.bybit.com/v5/...
      '/bybit': {
        target: 'https://api.bybit.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/bybit/, ''),
      },
    },
  },
})
