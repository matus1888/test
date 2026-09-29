/* eslint-disable no-restricted-globals */
/**
 * Service worker приложения «Скринер Bybit».
 *
 * Что и зачем кэшируем:
 * - навигация — network-first: сначала сеть (чтобы не застрять на старой сборке),
 *   при отсутствии сети отдаём кэшированный index.html; само приложение живёт на
 *   HashRouter, поэтому один index.html покрывает все маршруты;
 * - /assets/* (хешированные файлы сборки) — cache-first: имя меняется при каждой
 *   сборке, значит содержимое неизменно и его можно хранить вечно;
 * - манифест, иконки, favicon — cache-first из оболочки;
 * - запросы Bybit (api.bybit.com) НЕ кэшируем никогда: цены и свечи должны быть
 *   свежими, а приватные ответы в кэше браузера — лишний риск. Если сети нет,
 *   приложение само покажет ошибку загрузки, а не старые данные.
 *
 * ВЕРСИЮ поднимать при каждом изменении оболочки/логики кэша — activate чистит старые.
 */
const VERSION = 'v1';
const CACHE = `bybit-screener-${VERSION}`;

/** Оболочка: путь относительно sw.js, поэтому работает и на /, и на /<repo>/. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

/** Пути оболочки в виде pathname — чтобы матчить запросы, не разбирая пути руками. */
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location.href).pathname));

/** Разметка, если сети нет и даже оболочка не закэширована. */
const OFFLINE_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Скринер Bybit — нет сети</title><style>
body{background:#0b0d10;color:#d7dce3;font-family:system-ui,sans-serif;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}
div{max-width:420px}h1{font-size:20px;margin:0 0 10px}p{color:#8b93a1;font-size:14px;line-height:1.6;margin:0}
</style></head><body><div><h1>Нет соединения</h1>
<p>Приложение ещё ни разу не было загружено офлайн, а сеть недоступна. Откройте страницу
при подключённом интернете — дальше оболочка и последняя загруженная страница будут
доступны без сети. Данные Bybit всегда требуют сети: котировки и свечи не кэшируются.</p>
</div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // По одному файлу: отсутствие иконки не должно ронять установку воркера.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('bybit-screener-') && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Ответ из кэша, иначе сеть с дозаписью в кэш. */
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const cache = await caches.open(CACHE);
    cache.put(request, res.clone());
  }
  return res;
}

/** Сеть, при неудаче — кэш навигации (index.html), затем страница «нет сети». */
async function networkFirstPage(request) {
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
      // Держим и «голый» index.html: он нужен как офлайн-замена при смене адреса.
      const shellUrl = new URL('./index.html', self.registration.scope).href;
      cache.put(shellUrl, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await caches.match(new URL('./index.html', self.registration.scope).href, { ignoreSearch: true });
    if (shell) return shell;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Чужойorigin (api.bybit.com, CORS-прокси dev-сервера) не трогаем вообще.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

// Новая сборка ждёт подтверждения: main.tsx шлёт skipWaiting (см. swReady).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
