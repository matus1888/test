import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

// GitHub Pages: для project site нужен base '/<repo>/', для user site — '/'.
// Определяется автоматически из GITHUB_REPOSITORY в CI, локально — '/'.
// Ручное переопределение: BASE_PATH=/my-repo/ bun run build
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base =
  process.env.BASE_PATH ??
  (repo && !repo.endsWith('.github.io') ? `/${repo}/` : '/')

const DEV_KEYS_ID = 'virtual:bybit-dev-keys'
const DEV_KEYS_RESOLVED = `\0${DEV_KEYS_ID}`
const EMPTY_KEYS = { key: '', secret: '', testnet: false }

interface DevKeys {
  key: string
  secret: string
  testnet: boolean
}

/** Ключи из .env: API_KEY/API_SECRET (или BYBIT_API_KEY/BYBIT_API_SECRET), API_TESTNET=1 — тестнет. */
function readDevKeys(mode: string, command: string): DevKeys {
  // Только локальный dev-сервер. В сборке — пустые значения, поэтому секреты
  // физически не могут попасть в dist/ (проверяется grep'ом по dist в плане проверки).
  if (command !== 'serve') return EMPTY_KEYS
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '')
  const flag = (env.API_TESTNET ?? '').trim().toLowerCase()
  return {
    key: (env.API_KEY || env.BYBIT_API_KEY || '').trim(),
    secret: (env.API_SECRET || env.BYBIT_API_SECRET || '').trim(),
    testnet: ['1', 'true', 'yes', 'on'].includes(flag),
  }
}

/**
 * Виртуальный модуль с ключами Bybit — чтобы не вводить их руками на /api.
 * Импортируется из src/api/privateApi.ts (devCredentials). Значения приходят только
 * из dev-сервера; в `bun run build` подставляется пустой объект. См. .env.example.
 */
function devBybitKeys(): Plugin {
  let keys: DevKeys = EMPTY_KEYS
  return {
    name: 'bybit-dev-keys',
    configResolved(config) {
      keys = readDevKeys(config.mode, config.command)
    },
    resolveId(id) {
      return id === DEV_KEYS_ID ? DEV_KEYS_RESOLVED : null
    },
    load(id) {
      return id === DEV_KEYS_RESOLVED ? `export default ${JSON.stringify(keys)}` : null
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), devBybitKeys()],
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
