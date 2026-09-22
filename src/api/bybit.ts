// Bybit V5 public market API. Docs: https://bybit-exchange.github.io/docs/v5/market/tickers
// Без ключа. Прямой base + fallback на Vite proxy (/bybit) при CORS-ошибке.

export type Category = 'spot' | 'linear' | 'inverse' | 'option';
export const CATEGORIES: Category[] = ['linear', 'spot', 'inverse', 'option'];

export type Interval =
  | '1' | '3' | '5' | '15' | '30' | '60' | '120'
  | '240' | '360' | '720' | 'D' | 'M' | 'W';
export const INTERVALS: Interval[] = [
  '1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'M', 'W',
];
export const INTERVAL_LABELS: Record<Interval, string> = {
  '1': '1 мин', '3': '3 мин', '5': '5 мин', '15': '15 мин', '30': '30 мин', '60': '1 ч',
  '120': '2 ч', '240': '4 ч', '360': '6 ч', '720': '12 ч', D: '1 д', M: '1 мес', W: '1 нед',
};

export const isCategory = (v: unknown): v is Category =>
  v === 'spot' || v === 'linear' || v === 'inverse' || v === 'option';

export const isInterval = (v: unknown): v is Interval =>
  typeof v === 'string' && (INTERVALS as string[]).includes(v);

const SPOT_QUOTES = ['USDT', 'USDC', 'USDE', 'BTC', 'ETH', 'DAI', 'USD'];

/**
 * Ссылка на реальную торговую пару на Bybit.
 * linear/inverse — прямые ссылки на терминал; spot — через базовую монету;
 * для option прямой ссылки нет (нужен выбор экспирации) — вернёт null.
 */
export function bybitTradeUrl(category: Category, symbol: string): string | null {
  const s = encodeURIComponent(symbol);
  if (category === 'linear') return `https://www.bybit.com/trade/usdt/${s}`;
  if (category === 'inverse') return `https://www.bybit.com/trade/inverse/${s}`;
  if (category === 'spot') {
    const q = SPOT_QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length);
    if (!q) return null;
    return `https://www.bybit.com/en/trade/spot/${encodeURIComponent(symbol.slice(0, -q.length))}/${s}`;
  }
  return null;
}

const DIRECT = 'https://api.bybit.com';
const PROXY = '/bybit'; // vite server.proxy, работает в dev

export interface Ticker {
  symbol: string;
  lastPrice: number;
  price24hPcnt: number; // доля, напр. 0.05 = +5%
  highPrice24h: number;
  lowPrice24h: number;
  volume24h: number;
  turnover24h: number;
  fundingRate: number | null;
  openInterest: number | null;
}

export interface Candle {
  time: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

interface BybitResp<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

async function getJSON<T>(path: string): Promise<T> {
  // Пробуем напрямую, при network/CORS-ошибке — через proxy
  try {
    const r = await fetch(`${DIRECT}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as BybitResp<T>;
    if (j.retCode !== 0) throw new Error(j.retMsg || `retCode ${j.retCode}`);
    return j.result;
  } catch (e) {
    if (typeof window === 'undefined') throw e;
    const r = await fetch(`${PROXY}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} (proxy)`);
    const j = (await r.json()) as BybitResp<T>;
    if (j.retCode !== 0) throw new Error(j.retMsg || `retCode ${j.retCode}`);
    return j.result;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function fetchTickers(category: Category): Promise<Ticker[]> {
  const result = await getJSON<{ list: Record<string, string>[] }>(
    `/v5/market/tickers?category=${category}`,
  );
  return result.list.map((t) => ({
    symbol: String(t.symbol ?? ''),
    lastPrice: num(t.lastPrice),
    price24hPcnt: num(t.price24hPcnt),
    highPrice24h: num(t.highPrice24h),
    lowPrice24h: num(t.lowPrice24h),
    volume24h: num(t.volume24h),
    turnover24h: num(t.turnover24h),
    fundingRate: t.fundingRate === undefined || t.fundingRate === '' ? null : num(t.fundingRate),
    openInterest: t.openInterest === undefined || t.openInterest === '' ? null : num(t.openInterest),
  })).filter((t) => t.symbol && t.lastPrice > 0);
}

// kline возвращает [start(ms), open, high, low, close, volume, turnover], новые первыми
export async function fetchKlines(
  category: Category,
  symbol: string,
  interval: Interval,
  limit = 200,
): Promise<Candle[]> {
  const n = Math.min(Math.max(limit, 10), 1000);
  const result = await getJSON<{ list: string[][] }>(
    `/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${n}`,
  );
  const rows = result.list
    .map((r) => ({
      time: Number(r[0]),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      volume: num(r[5]),
      turnover: num(r[6]),
    }))
    .filter((c) => Number.isFinite(c.time) && c.close > 0)
    .sort((a, b) => a.time - b.time);
  return rows;
}
