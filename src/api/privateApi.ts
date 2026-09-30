// Приватный Bybit V5 API: подпись HMAC-SHA256 и приватные запросы прямо из браузера.
// CORS Bybit V5 разрешает приватные вызовы клиентски (проверено живым запросом:
// GET wallet-balance с фейковой подписью доходит до сервера и возвращает 401,
// POST order/create — 200 с retCode 10002 «invalid request»). Свой сервер не нужен.
// ⚠️ retCode 10002 = «Request timestamp outside of receive timestamp range»: часы
// устройства (обычно телефона) вне окна recvWindow. Ключ при этом верный — см.
// синхронизацию времени ниже: подпись всегда идёт по времени биржи.
// ВАЖНО: секрет хранится в localStorage браузера. Для реальных денег используйте ключ
// без права вывода и с ограничением по IP, либо API-ключ тестнета.
// Для локальной работы ключи можно не вводить руками: положи их в `.env`
// (API_KEY / API_SECRET / API_TESTNET) — dev-сервер подставит их сам, см. vite.config.ts.

import type { Category } from './bybit';
import devKeys from 'virtual:bybit-dev-keys';
import { clockInfo, describeClock, harvestServerTime, nowBybitSafeMs, syncClockFrom } from '../lib/clock';
import { isTradeExecution } from '../lib/realHistory';

// Часы — общий модуль приложения (им пользуется ещё и бумажный движок), здесь
// переэкспортируем для тех, кто работает с приватным API.
export {
  CLOCK_EVENT,
  CLOCK_SYNC_TTL_MS,
  clockInfo,
  clockOffsetMs,
  describeClock,
  isClockSynced,
  nowBybitMs,
  nowBybitSafeMs,
  resetClockSync,
  type ClockInfo,
} from '../lib/clock';

export interface ApiCredentials {
  key: string;
  secret: string;
  testnet: boolean;
}

interface PrivateResult<T> {
  retCode: number;
  retMsg: string;
  result: T;
  /**
   * Время биржи в теле ответа. У приватных ответов V5 его нет (только в заголовке
   * `timenow`, который CORS не отдаёт скрипту) — поэтому здесь только разбор ответа,
   * а часы выравниваются публичными запросами (см. `harvestServerTime`).
   */
  time?: string;
}

const STORE_KEY = 'bybit:api:credentials:v1';
/** Ключи «не сохранять» — только в памяти текущей вкладки, не персистятся. */
let sessionCreds: ApiCredentials | null = null;
/**
 * Окно приёма подписи, мс. Bybit разрешает до 60 000 — берём максимум.
 *
 * Логика живого случая (телефон, 30.09.2026): биржа проэхо-ит в тексте ошибки НАШЕ
 * окно (10 с) и нашу метку, которая на 1,6 с опережала её часы, — и всё равно
 * отказала. Значит проверка шла не с той меткой времени, что в сообщении: на
 * мобильной сети запрос может простоять в очереди у оператора несколько секунд,
 * и к моменту проверки расхождение становится больше, чем показывает текст ошибки.
 * Лесенка повторов («состарить» метку) бьёт по этому, а большое окно делает класс
 * таких отказов невозможным в принципе. Риск для безопасности нулевой: окно
 * только смягчает проверку метки и не влияет ни на что, кроме защиты от replay
 * в пределах минуты.
 */
const RECV_WINDOW = 60_000;

/** Окно приёма подписи, мс (экспортируем для тестов: подпись зависит от него). */
export { RECV_WINDOW };
const MAIN = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';

/**
 * Ключи из `.env` — только для локального dev-сервера (`bun run dev`): их отдаёт
 * виртуальный модуль `virtual:bybit-dev-keys` (плагин devBybitKeys в vite.config.ts).
 * В сборке (`bun run build`) значения пустые, поэтому секреты не попадают в dist/.
 * Приоритет: localStorage → `.env`.
 */
const DEV_BYBIT = devKeys;

export function apiBase(testnet: boolean): string {
  return testnet ? TESTNET : MAIN;
}

export function isCredentials(v: unknown): v is ApiCredentials {
  return typeof v === 'object' && v !== null && typeof (v as { key?: unknown }).key === 'string' && typeof (v as { secret?: unknown }).secret === 'string';
}

/** Валидирует сырые ключи (из `.env`): нужны непустые key и secret. */
export function parseDevCredentials(raw: unknown): ApiCredentials | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { key, secret, testnet } = raw as { key?: unknown; secret?: unknown; testnet?: unknown };
  if (typeof key !== 'string' || key.trim() === '') return null;
  if (typeof secret !== 'string' || secret.trim() === '') return null;
  return { key: key.trim(), secret: secret.trim(), testnet: testnet === true };
}

/** Ключи из `.env` для локальной работы; null — если их нет или это сборка/тесты. */
export function devCredentials(): ApiCredentials | null {
  return parseDevCredentials(DEV_BYBIT);
}

/** Есть ли ключи, сохранённые самим пользователем в localStorage. */
export function hasStoredCredentials(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) != null;
  } catch {
    return false;
  }
}

/** Ключи для приватных запросов: сессионные (не персистенные) → localStorage → `.env`. */
export function loadCredentials(): ApiCredentials | null {
  if (sessionCreds != null) return sessionCreds;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (isCredentials(parsed)) return parsed;
    }
  } catch {
    /* localStorage недоступен или битый — пробуем .env */
  }
  return devCredentials();
}

/**
 * Ключи из формы. Мобильный ввод (и copy-paste из мессенджера/заметок) приносит
 * пробелы и переносы строк, а iOS ещё и capitalize первую букву секрета — с таким
 * значением подпись не сойдётся и биржа ответит 10004. Чистим только пробелы:
 * регистр у секрета значимый.
 */
export function normalizeCredential(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * Сохранить ключи. `persist: false` — только в память вкладки (локальная сессия),
 * ничего не пишется на диск браузера; после закрытия вкладки ключи исчезают.
 */
export function saveCredentials(c: ApiCredentials, persist = true): void {
  const clean: ApiCredentials = {
    key: normalizeCredential(c.key),
    secret: normalizeCredential(c.secret),
    testnet: c.testnet,
  };
  if (persist) {
    sessionCreds = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(clean));
    } catch {
      /* localStorage недоступен — работаем без персиста */
    }
  } else {
    sessionCreds = clean;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* noop */
    }
  }
  // Часы телефона могут быть сбиты — выравниваемся о биржу заранее, до первого запроса.
  void syncClock(clean.testnet);
  notifyCredentials();
}

export function clearCredentials(): void {
  sessionCreds = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* noop */
  }
  notifyCredentials();
}

/**
 * Событие «ключи изменились»: страницы с хуком `useApiAccount` (шапка, /api, /real)
 * перечитывают ключи, чтобы портфель сразу показал новый счёт.
 */
export const CREDENTIALS_EVENT = 'bybit:credentials-changed';

function notifyCredentials(): void {
  try {
    window.dispatchEvent(new Event(CREDENTIALS_EVENT));
  } catch {
    /* нет window (тесты/SSR) — перечитывание не нужно */
  }
}

/** HMAC-SHA256 в hex (Web Crypto; в Node — node:crypto, используется в тестах для сверки). */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Часы приватных запросов ─────────────────────────────────────────────────
//
// Подпись идёт по времени БИРЖИ (`lib/clock.ts`), а не по часам устройства:
// со сбитыми часами телефона биржа отвечает `10002 Request timestamp outside of
// receive timestamp range` на любой приватный запрос — на баланс, на вход и на
// рыночное закрытие, — хотя ключ верный. Поэтому часы живут отдельным модулем
// (их использует ещё и бумажный движок), а здесь только привязка к сети.

/** Выровнять часы о время биржи для нужной сети. Никогда не бросает. */
export function syncClock(testnet: boolean, force = false): Promise<number> {
  return syncClockFrom(apiBase(testnet), force);
}

/** GET-query: ключи сортируются явно, чтобы подпись была детерминированной во всех средах. */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') entries.push([k, String(v)]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/**
 * Числа из retMsg при 10002: `req_timestamp[…]`, `server_timestamp[…]`,
 * `recv_window[…]`. По ним видно, врёт ли время устройства. Если метка внутри окна,
 * отказ пришёл не от проверки времени — на живом телефоне с ручным вводом ключа это
 * ключ или сеть (тестнет/мейннет), а не часы.
 */
export function parseTimestampSkew(retMsg: string): { skewMs: number; windowMs: number } | null {
  const req = Number(/req_timestamp\[(-?\d+)\]/.exec(retMsg)?.[1]);
  const srv = Number(/server_timestamp\[(-?\d+)\]/.exec(retMsg)?.[1]);
  const win = Number(/recv_window\[(-?\d+)\]/.exec(retMsg)?.[1]);
  if (!Number.isFinite(req) || !Number.isFinite(srv)) return null;
  return { skewMs: req - srv, windowMs: Number.isFinite(win) && win > 0 ? win : RECV_WINDOW };
}

const sec = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;

/**
 * 10002 — отказ на проверке подписи, до обработки заявки. Для реальных денег это важно:
 * пользователь нажал «Закрыть по рынку» и должен знать, что позиция осталась открытой,
 * а не что «возможно, закрылась». Проверка подписи идёт первым шагом пайплайна биржи,
 * поэтому отказ по метке времени гарантированно ничего не меняет на счёте.
 */
const SAFE_NO_STATE_CHANGE = 'заявка отклонена на проверке подписи, на счёте ничего не изменилось — действие можно повторить';

/** Человеческое объяснение retCode. Для 10002 — по числам из ответа, а не наугад. */
function errorHint(retCode: number, retMsg: string): string {
  if (retCode === 10004) {
    return ' — неверный API-ключ или секрет: перекопируй их целиком, без пробелов и кавычек';
  }
  if (retCode !== 10002) return '';
  const t = parseTimestampSkew(retMsg);
  const clock = describeClock();
  if (t && Math.abs(t.skewMs) * 2 < t.windowMs) {
    // Метка внутри окна: отказ пришёл не от проверки времени. Живой случай (телефон,
    // 30.09.2026): метка на 1,6 с впереди сервера при окне 10 с — ключ перепроверен,
    // сеть исправна (скринер грузится), стенд и IP верны, а отказ всё равно. Позже в
    // тот же день тот же ключ с телефона подключился без ошибки ⇒ отказ был не свойством
    // ключа, а задержкой запроса в мобильной сети в тот момент.
    return ` — время в порядке (метка на ${sec(Math.abs(t.skewMs))} ${t.skewMs > 0 ? 'впереди' : 'позади'} сервера при окне ${sec(t.windowMs)}), отказ не во времени${clock.startsWith('синхронизировано') ? '' : '; синхронизация часов недоступна'}; ${SAFE_NO_STATE_CHANGE}`;
  }
  return ` — время устройства вне окна биржи${clock.startsWith('синхронизировано') ? ` [${clock}]` : ''}: проверь автоопределение даты и времени (Настройки → Дата и время); ${SAFE_NO_STATE_CHANGE}`;
}

/**
 * Отпечаток учётных данных для сверки: публичная часть ключа, стенд и 12 символов
 * подписи от секрета. Секрет при этом не раскрывается — HMAC от фиксированной строки
 * необратим, а одинаковый секрет даёт одинаковый отпечаток. Нужен, когда ключ вводится
 * вручную на телефоне: прислал отпечаток — и видно, тот ли это ключ, без показа секрета.
 */
export async function credentialFingerprint(cred: ApiCredentials): Promise<{ fp: string; stand: string }> {
  const fp = (await hmacHex(cred.secret, 'fingerprint').catch(() => '')).slice(0, 12);
  return { fp, stand: cred.testnet ? 'тестнет' : 'мейннет' };
}

/**
 * Что именно мы отправили как метку времени — числами, для текста ошибки.
 * Если отсюда видно, что метка была заведомо нормальной (окно 60 с), а биржа
 * всё равно отказала, то отказ пришёл не от нашей метки: запрос переписали на
 * пути (прокси оператора, воркер) либо метку читали не оттуда. Это уже не догадка.
 * `rttMs` — время в пути именно этого запроса: если оно в разы больше обычного,
 * то метка успела устареть в очереди оператора — самая проверяемая версия.
 */
function stampForensics(timestamp: string, rttMs?: number): string {
  const info = clockInfo();
  const sent = Number(timestamp);
  const device = Date.now();
  if (!Number.isFinite(sent)) return `метка «${timestamp}» не число`;
  const sync = info.synced
    ? `синхронизация ${Math.round((device - info.syncedAt) / 1000)} с назад, смещение ${info.offsetMs} мс`
    : 'синхронизации НЕ было — подписано часами устройства';
  const rtt = Number.isFinite(rttMs) ? `, летел ${rttMs} мс` : '';
  return `метка ${sent} (${sent <= device ? 'позади' : 'впереди'} часов устройства на ${Math.abs(device - sent)} мс), ${sync}, окно ${RECV_WINDOW}${rtt}`;
}

/**
 * Диагностика отказа, когда ключ перепроверен, а часы по цифрам ответа в порядке.
 * Три дешёвые read-only проверки вместо догадок:
 * 1) отпечаток ключа и секрета — его можно прислать и сверить с рабочим, не публикуя
 *    сам секрет (HMAC от фиксированной строки, 12 символов);
 * 2) устойчива ли подпись, которую мы реально отправляем, — она обязана быть устойчивой,
 *    иначе биржа ответила бы 10004, а не 10002;
 * 3) принимает ли тот же ключ ПРОТИВОПОЛОЖНЫЙ стенд — если да, в форме выбран не тот.
 */
async function errorHintAsync(
  retCode: number,
  retMsg: string,
  cred: ApiCredentials,
  noProbe = false,
  stamp = '',
): Promise<string> {
  const base = errorHint(retCode, retMsg);
  if (retCode !== 10002) return base;
  const t = parseTimestampSkew(retMsg);
  if (!t || Math.abs(t.skewMs) * 2 >= t.windowMs) return base;

  const odd = /[^A-Za-z0-9]/.test(cred.key) || /[^A-Za-z0-9]/.test(cred.secret);
  let stable = 'подпись пересчитать не удалось';
  try {
    const a = await hmacHex(cred.secret, 'diag');
    const b = await hmacHex(cred.secret, 'diag');
    stable = a === b ? 'подпись устойчива' : 'подпись НЕУСТОЙЧИВА';
  } catch {
    /* WebCrypto недоступен (небезопасный контекст) — выводов не делаем */
  }
  const { fp, stand } = await credentialFingerprint(cred);
  const other = noProbe ? 'второй стенд не проверялся' : await probeOtherStand(cred);
  return (
    `${base}. Диагностика: ${stable}${odd ? ', в ключе или секрете есть посторонние символы' : ''}; ${other}` +
    (stamp ? `; отправлено: ${stamp}` : '') +
    `; отпечаток: ${cred.key} / ${stand} / секрет ${fp || '—'} ` +
    '(эту строку можно прислать — по ней ключ сверяется, не показывая секрет)'
  );
}

/** Тот же ключ на противоположном стенде: read-only запрос баланса. */
async function probeOtherStand(cred: ApiCredentials): Promise<string> {
  const other = { ...cred, testnet: !cred.testnet };
  try {
    await requestPrivate(
      'GET', '/v5/account/wallet-balance',
      { accountType: 'UNIFIED', settleCoin: 'USDT' },
      other,
      { tries: 2, noProbe: true },
    );
    return `КЛЮЧ РАБОТАЕТ НА ${other.testnet ? 'ТЕСТНЕТЕ' : 'МЕЙННЕТЕ'} — в форме выбран не тот стенд`;
  } catch {
    return 'на втором стенде ключ тоже не принимается';
  }
}

export async function requestPrivate<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, unknown> = {},
  cred: ApiCredentials,
  opts: {
    ignoreRetCodes?: number[];
    /** Сколько раз уже повторяли после 10002 (лесенка «состарить» метку). */
    tries?: number;
    /** На сколько мс метка времени в этой попытке старше настоящей. */
    skewMs?: number;
    /** Внутреннее: не проверять второй стенд (иначе проба вызовет саму себя). */
    noProbe?: boolean;
  } = {},
): Promise<T> {
  // Подписывать сбитыми часами телефона бессмысленно: сначала раз в 30 мин
  // выравниваемся о время биржи, а метку подписи берём с запасом на сетевой лаг.
  await syncClock(cred.testnet);
  // skewMs — насколько «состарить» метку в этой попытке (лестница повторов после 10002).
  const timestamp = String(nowBybitSafeMs() - (opts.skewMs ?? 0));
  let url = `${apiBase(cred.testnet)}${path}`;
  let body = '';
  let message = '';
  if (method === 'GET') {
    const query = buildQuery(params as Record<string, string | number | boolean | undefined>);
    if (query) url += `?${query}`;
    message = `${timestamp}${cred.key}${RECV_WINDOW}${query}`;
  } else {
    body = JSON.stringify(params);
    message = `${timestamp}${cred.key}${RECV_WINDOW}${body}`;
  }
  const sign = await hmacHex(cred.secret, message);
  const headers: Record<string, string> = {
    'X-BAPI-API-KEY': cred.key,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
    'X-BAPI-SIGN': sign,
  };
  const sentAt = Date.now();
  const response = await fetch(url, {
    method,
    headers: method === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: method === 'POST' ? body : undefined,
  });
  const gotAt = Date.now();
  const text = await response.text();
  let j: PrivateResult<T>;
  try {
    j = JSON.parse(text) as PrivateResult<T>;
  } catch {
    throw new Error(`HTTP ${response.status} (${text.slice(0, 120)})`);
  }
  // Если биржа всё-таки положила время в тело ответа — подхватываем (у приватных V5
  // обычно нет, но формат может измениться). Основной источник — публичные ответы.
  harvestServerTime(j.time, sentAt, gotAt);
  if (j.retCode !== 0) {
    // 110043 «leverage not modified» — целевое плечо уже установлено, это не ошибка:
    // повторный вызов с тем же значением не меняет состояние счёта.
    if (opts.ignoreRetCodes?.includes(j.retCode)) return j.result;
    // 10002 при метке внутри окна — биржа отклонила подпись по существу, а не из-за
    // часов. Но у мобильных сетей метка успевает «состариться» в полёте (ошибка была
    // при расхождении 1,6 с — внутри окна, отказ всё равно), поэтому перед выводом
    // «виноват ключ» пробуем ещё две попытки: метка на 2,5 с и на 5 с старше биржевой.
    // Повтор безопасен и для POST: 10002 означает, что заявка биржей не принята.
    const tries = opts.tries ?? 0;
    if (j.retCode === 10002 && tries < 2) {
      await syncClock(cred.testnet, true);
      return requestPrivate<T>(method, path, params, cred, {
        ...opts,
        tries: tries + 1,
        skewMs: 2500 * (tries + 1),
      });
    }
    const hint = j.retCode === 10002
      ? await errorHintAsync(j.retCode, j.retMsg, cred, opts.noProbe === true, stampForensics(timestamp, gotAt - sentAt))
      : errorHint(j.retCode, j.retMsg);
    throw new Error(`${j.retMsg} (retCode ${j.retCode})${hint}`);
  }
  return j.result;
}

// ── Типы и типовые запросы ────────────────────────────────────────────────

/**
 * Bybit требует в «широких» запросах (order/realtime, order/cancel-all) либо symbol,
 * либо монету расчётов: settleCoin для linear/inverse и baseCoin для spot.
 * Без этого эндпоинты отвечают 10001 «Missing some parameters» (проверено на mainnet).
 * Здесь предполагается USDT-расчёт — как и во всём остальном приватном API.
 */
function scopeParams(category: Category, symbol?: string): Record<string, string> {
  if (symbol) return { symbol };
  return category === 'spot' ? { baseCoin: 'USDT' } : { settleCoin: 'USDT' };
}

export interface CoinBalance {
  coin: string;
  walletBalance: number;
  equity: number;
  availableToWithdraw: number;
  usdValue: number;
  /** Маржа под позициями этой монеты (Bybit шлёт здесь, а не в полях аккаунта). */
  positionIM: number;
  /** Маржа под висящими ордерами этой монеты. */
  orderIM: number;
}

export interface WalletBalance {
  accountType: string;
  totalEquity: number;
  totalWalletBalance: number;
  totalMarginBalance: number;
  totalAvailableBalance: number;
  /** Нереализованный P&L по перпетуарам (UNIFIED). */
  totalPerpUPL: number;
  /** Начальная маржа: занятая позициями + под висящими ордерами. */
  totalInitialMargin: number;
  totalPositionInitialMargin: number;
  totalOrderInitialMargin: number;
  coins: CoinBalance[];
}

export async function fetchWalletBalance(cred: ApiCredentials, accountType = 'UNIFIED'): Promise<WalletBalance> {
  // Bybit V5 отдаёт баланс как массив аккаунтов (`result.list`), агрегированные поля —
  // в `list[0]`, а монеты — в `list[0].coin`. Проверено живым ответом: без этого
  // уровня totalEquity/кошелёк читаются как 0, и счёт с деньгами показывал «0 $».
  // Маржу (IM = initial margin) Bybit шлёт НЕ в полях аккаунта (totalInitialMargin и
  // totalAvailableBalance приходят пустыми «»), а внутри каждой монеты:
  // coin[].totalPositionIM / coin[].totalOrderIM. Собираем её вручную.
  interface WalletAccount {
    accountType: string;
    totalEquity: string;
    totalWalletBalance: string;
    totalMarginBalance: string;
    totalAvailableBalance: string;
    totalPerpUPL?: string;
    totalInitialMargin?: string;
    totalPositionInitialMargin?: string;
    totalOrderInitialMargin?: string;
    coin?: {
      coin: string; walletBalance: string; equity: string;
      availableToWithdraw: string; usdValue: string;
      totalPositionIM?: string; totalOrderIM?: string;
    }[];
  }
  const res = await requestPrivate<{ list?: WalletAccount[] }>('GET', '/v5/account/wallet-balance', { accountType }, cred);
  const acc: WalletAccount = res.list?.[0] ?? {
    accountType, totalEquity: '', totalWalletBalance: '', totalMarginBalance: '',
    totalAvailableBalance: '', totalPerpUPL: '', totalInitialMargin: '',
    totalPositionInitialMargin: '', totalOrderInitialMargin: '', coin: [],
  };
  const num = (v?: string | number) => Number(v ?? 0);
  const coins: CoinBalance[] = (acc.coin ?? []).map((c) => ({
    coin: c.coin,
    walletBalance: num(c.walletBalance),
    equity: num(c.equity),
    availableToWithdraw: num(c.availableToWithdraw),
    usdValue: num(c.usdValue),
    positionIM: num(c.totalPositionIM),
    orderIM: num(c.totalOrderIM),
  }));
  const positionIM = coins.reduce((a, c) => a + c.positionIM, 0);
  const orderIM = coins.reduce((a, c) => a + c.orderIM, 0);
  const initialMargin = positionIM + orderIM;
  const equity = num(acc.totalEquity);
  return {
    accountType: acc.accountType,
    totalEquity: equity,
    totalWalletBalance: num(acc.totalWalletBalance),
    totalMarginBalance: num(acc.totalMarginBalance) || equity,
    totalAvailableBalance: num(acc.totalAvailableBalance) || Math.max(0, equity - initialMargin),
    totalPerpUPL: num(acc.totalPerpUPL),
    totalInitialMargin: num(acc.totalInitialMargin) || initialMargin,
    totalPositionInitialMargin: num(acc.totalPositionInitialMargin) || positionIM,
    totalOrderInitialMargin: num(acc.totalOrderInitialMargin) || orderIM,
    coins,
  };
}

export interface ApiPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  avgPrice: number;
  markPrice: number;
  leverage: number;
  positionIdx: number;
  liqPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  unrealisedPnl: number;
  positionStatus: string;
}

export async function fetchPositions(cred: ApiCredentials, category: Category = 'linear'): Promise<ApiPosition[]> {
  const res = await requestPrivate<{ list?: Record<string, string>[] }>(
    'GET', '/v5/position/list', { category, settleCoin: 'USDT' }, cred,
  );
  return (res.list ?? []).map((p) => ({
    symbol: String(p.symbol ?? ''),
    side: (String(p.side ?? '') || 'Buy') as ApiPosition['side'],
    size: Number(p.size ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    markPrice: Number(p.markPrice ?? 0),
    leverage: Number(p.leverage ?? 1),
    positionIdx: Number(p.positionIdx ?? 0),
    liqPrice: p.liqPrice ? Number(p.liqPrice) : null,
    takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
    stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
    unrealisedPnl: Number(p.unrealisedPnl ?? 0),
    positionStatus: String(p.positionStatus ?? ''),
  })).filter((p) => p.symbol && p.size > 0); // size "0" — позиция закрыта, Bybit её всё равно шлёт
}

export interface SetLeverageArgs {
  category: Category;
  symbol: string;
  leverage: number;
  positionIdx?: number;
}

export async function setLeverage(cred: ApiCredentials, args: SetLeverageArgs): Promise<void> {
  // 110043 «leverage not modified» — плечо уже такое, повторное совпадение не меняет счёт.
  await requestPrivate('POST', '/v5/position/set-leverage', {
    category: args.category,
    symbol: args.symbol,
    buyLeverage: String(args.leverage),
    sellLeverage: String(args.leverage),
    ...(args.positionIdx != null ? { positionIdx: args.positionIdx } : {}),
  }, cred, { ignoreRetCodes: [110043] });
}

export interface PlaceOrderArgs {
  category: Category;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
  positionIdx?: number;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  takeProfit?: string;
  stopLoss?: string;
  tpTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
  slTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
  triggerPrice?: string;
  triggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
  triggerDirection?: 1 | 2;
  orderLinkId?: string;
}

export interface OrderResult {
  orderId: string;
  orderLinkId?: string;
}

export async function placeOrder(cred: ApiCredentials, args: PlaceOrderArgs): Promise<OrderResult> {
  const { category, symbol, side, orderType, qty, price, timeInForce, positionIdx,
    reduceOnly, closeOnTrigger, takeProfit, stopLoss, tpTriggerBy, slTriggerBy,
    triggerPrice, triggerBy, triggerDirection, orderLinkId } = args;
  const res = await requestPrivate<{ orderId: string; orderLinkId?: string }>('POST', '/v5/order/create', {
    category, symbol, side, orderType, qty,
    ...(price ? { price } : {}),
    ...(timeInForce ? { timeInForce } : {}),
    ...(positionIdx != null ? { positionIdx } : {}),
    ...(reduceOnly ? { reduceOnly: true } : {}),
    ...(closeOnTrigger ? { closeOnTrigger: true } : {}),
    ...(takeProfit ? { takeProfit } : {}),
    ...(stopLoss ? { stopLoss } : {}),
    ...(tpTriggerBy ? { tpTriggerBy } : {}),
    ...(slTriggerBy ? { slTriggerBy } : {}),
    ...(triggerPrice ? { triggerPrice } : {}),
    ...(triggerBy ? { triggerBy } : {}),
    ...(triggerDirection ? { triggerDirection } : {}),
    ...(orderLinkId ? { orderLinkId } : {}),
  }, cred);
  return res;
}

export async function cancelAll(cred: ApiCredentials, category: Category, symbol?: string): Promise<void> {
  await requestPrivate('POST', '/v5/order/cancel-all', {
    category,
    ...scopeParams(category, symbol),
  }, cred);
}

export interface ActiveOrder {
  orderId: string;
  orderLinkId?: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: string;
  qty: number;
  price: number;
  orderStatus: string;
  stopLoss: number | null;
  takeProfit: number | null;
  timeInForce?: string;
}

export async function fetchActiveOrders(cred: ApiCredentials, category: Category = 'linear', symbol?: string): Promise<ActiveOrder[]> {
  const res = await requestPrivate<{ list?: Record<string, string>[] }>(
    'GET', '/v5/order/realtime', { category, ...scopeParams(category, symbol) }, cred,
  );
  return (res.list ?? []).map((o) => ({
    orderId: String(o.orderId ?? ''),
    orderLinkId: o.orderLinkId ? String(o.orderLinkId) : undefined,
    symbol: String(o.symbol ?? ''),
    side: (String(o.side ?? '') || 'Buy') as ActiveOrder['side'],
    orderType: String(o.orderType ?? ''),
    qty: Number(o.qty ?? 0),
    price: Number(o.price ?? 0),
    orderStatus: String(o.orderStatus ?? ''),
    stopLoss: o.stopLoss ? Number(o.stopLoss) : null,
    takeProfit: o.takeProfit ? Number(o.takeProfit) : null,
    timeInForce: o.timeInForce ? String(o.timeInForce) : undefined,
  })).filter((o) => o.orderStatus.toLowerCase() !== 'cancelled' && o.orderStatus.toLowerCase() !== 'canceled' && o.orderStatus.toLowerCase() !== 'rejected'); // Bybit пишет «Cancelled» с двумя l
}

export async function cancelOrder(cred: ApiCredentials, category: Category, orderId: string, symbol: string): Promise<void> {
  // Bybit требует symbol у /v5/order/cancel: без него — 10001 params error: symbol invalid
  // (проверено живым запросом на mainnet 30.09.2026 — кнопка «Отменить» не снимала ордер).
  await requestPrivate('POST', '/v5/order/cancel', { category, symbol, orderId }, cred);
}

/** Установить позиционный TP/SL (например, перенести стоп в безубыток после TP1). */
export async function setPositionTradingStop(
  cred: ApiCredentials,
  args: {
    category: Category;
    symbol: string;
    stopLoss?: string;
    takeProfit?: string;
    slTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
    tpTriggerBy?: 'LastPrice' | 'IndexPrice' | 'MarkPrice';
    positionIdx?: number;
  },
): Promise<void> {
  await requestPrivate('POST', '/v5/position/trading-stop', {
    category: args.category,
    symbol: args.symbol,
    ...(args.stopLoss != null ? { stopLoss: args.stopLoss } : {}),
    ...(args.takeProfit != null ? { takeProfit: args.takeProfit } : {}),
    ...(args.slTriggerBy ? { slTriggerBy: args.slTriggerBy } : {}),
    ...(args.tpTriggerBy ? { tpTriggerBy: args.tpTriggerBy } : {}),
    ...(args.positionIdx != null ? { positionIdx: args.positionIdx } : {}),
  }, cred);
}

/** Одно исполнение (филла) из истории `/v5/execution/list`. */
export interface ApiExecution {
  execId: string;
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  price: number;
  fee: number;
  execPnl: number;
  execType: string;
  execTime: number;
  orderType: string;
  orderLinkId?: string;
}

/**
 * История исполнений (закрытые/частичные филлы). Bybit хранит ограниченную глубину —
 * поэтому стор честно говорит «сколько видит биржа», а не «вся история».
 * Так же читает лента на /live; здесь — REST-страховка и первичное наполнение.
 *
 * ⚠️ Кроме торговых филлов биржа отдаёт служебные строки — прежде всего
 * `execType: "Funding"` (начисление фандинга, orderType UNKNOWN). Это не сделка,
 * поэтому такие строки отбрасываются здесь: принятая за вход или выход, она удваивает
 * номинал и даёт фантомный P&L (живая проверка 30.09.2026: «сегодня +363 $»).
 */
export async function fetchExecutions(cred: ApiCredentials, category: Category = 'linear', limit = 50): Promise<ApiExecution[]> {
  const res = await requestPrivate<{ list?: Record<string, string>[] }>(
    'GET', '/v5/execution/list', { category, settleCoin: 'USDT', limit: String(limit) }, cred,
  );
  return (res.list ?? []).map((e) => ({
    execId: String(e.execId ?? ''),
    orderId: String(e.orderId ?? ''),
    symbol: String(e.symbol ?? ''),
    side: (String(e.side ?? '') || 'Buy') as ApiExecution['side'],
    qty: Number(e.execQty ?? 0),
    price: Number(e.execPrice ?? 0),
    fee: Number(e.execFee ?? 0),
    execPnl: Number(e.execPnl ?? 0),
    execType: String(e.execType ?? ''),
    execTime: Number(e.execTime ?? 0),
    orderType: String(e.orderType ?? ''),
    orderLinkId: e.orderLinkId ? String(e.orderLinkId) : undefined,
  })).filter((e) => e.execId && e.symbol && isTradeExecution(e));
}
