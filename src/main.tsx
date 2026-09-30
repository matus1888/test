import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { syncClock } from './api/privateApi'

const client = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false },
  },
})

/**
 * Сверяем часы устройства со временем биржи сразу при старте (публичный эндпоинт,
 * ключ не нужен). Иначе на телефоне со сбитым временем первая же подпись уехала бы
 * за окно биржи (retCode 10002) — на входе, на балансе и на рыночном закрытии, — а
 * ещё расходились бы моменты исполнений в бумажном движке и граница «сегодня».
 * Ошибка не блокирует запуск: без сети остаёмся на системном времени.
 */
void syncClock(false)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

/**
 * Service worker (PWA) — только в продакшен-сборке. В dev он кэшировал бы модули Vite
 * и ломал бы HMR. Путь берём от BASE_URL: на GitHub Pages проект живёт в /<repo>/,
 * поэтому '/sw.js' запросил бы 404. Данные Bybit воркер не кэширует (см. public/sw.js):
 * котировки и свечи всегда должны быть свежими, приватные ответы — не лежать в кэше.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((reg) => {
        // Новая сборка ждёт подтверждения — включаем её сразу, чтобы не остаться
        // на старой версии воркера (его activate чистит старые кэши).
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              sw.postMessage('skip-waiting')
            }
          })
        })
      })
      .catch((e) => console.warn('service worker не зарегистрирован:', e))
  })
}
