// Приватный Bybit V5 API: подпись HMAC-SHA256 и приватные запросы прямо из браузера.
// CORS Bybit V5 разрешает приватные вызовы клиентски (проверено живым запросом:
// GET wallet-balance с фейковой подписью доходит до сервера и возвращает 401,
// POST order/create — 200 с retCode 10002 «invalid request»). Свой сервер не нужен.
// ВАЖНО: секрет хранится в localStorage браузера. Для реальных денег используйте ключ
// без права вывода и с ограничением по IP, либо API-ключ тестнета.

import type { Category } from './bybit';

export interface ApiCredentials {
  key: string;
  secret: string;
  testnet: boolean;
}

interface PrivateResult<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

const STORE_KEY = 'bybit:api:credentials:v1';
const RECV_WINDOW = 5000;
const MAIN = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';

export function apiBase(testnet: boolean): string {
  return testnet ? TESTNET : MAIN;
}

export function isCredentials(v: unknown): v is ApiCredentials {
  return typeof v === 'object' && v !== null && typeof (v as { key?: unknown }).key === 'string' && typeof (v as { secret?: unknown }).secret === 'string';
}

export function loadCredentials(): ApiCredentials | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCredentials(c: ApiCredentials): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    /* localStorage недоступен — работаем без персиста */
  }
}

export function clearCredentials(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* noop */
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

/** GET-query: ключи сортируются явно, чтобы подпись была детерминированной во всех средах. */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') entries.push([k, String(v)]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

export async function requestPrivate<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, unknown> = {},
  cred: ApiCredentials,
): Promise<T> {
  const timestamp = String(Date.now());
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
  const response = await fetch(url, {
    method,
    headers: method === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: method === 'POST' ? body : undefined,
  });
  const text = await response.text();
  let j: PrivateResult<T>;
  try {
    j = JSON.parse(text) as PrivateResult<T>;
  } catch {
    throw new Error(`HTTP ${response.status} (${text.slice(0, 120)})`);
  }
  if (j.retCode !== 0) {
    // retCode 10002/10004 — «invalid request/signature»: чаще всего неверный ключ или время.
    const hint = j.retCode === 10002 || j.retCode === 10004 ? ' — проверь ключ/секрет и синхронизацию времени' : '';
    throw new Error(`${j.retMsg} (retCode ${j.retCode})${hint}`);
  }
  return j.result;
}

// ── Типы и типовые запросы ────────────────────────────────────────────────

export interface CoinBalance {
  coin: string;
  walletBalance: number;
  equity: number;
  availableToWithdraw: number;
  usdValue: number;
}

export interface WalletBalance {
  accountType: string;
  totalEquity: number;
  totalWalletBalance: number;
  totalMarginBalance: number;
  totalAvailableBalance: number;
  coins: CoinBalance[];
}

export async function fetchWalletBalance(cred: ApiCredentials, accountType = 'UNIFIED'): Promise<WalletBalance> {
  const res = await requestPrivate<{
    accountType: string;
    totalEquity: string;
    totalWalletBalance: string;
    totalMarginBalance: string;
    totalAvailableBalance: string;
    list?: { coin: string; walletBalance: string; equity: string; availableToWithdraw: string; usdValue: string }[];
  }>('GET', '/v5/account/wallet-balance', { accountType }, cred);
  const num = (v?: string | number) => Number(v ?? 0);
  return {
    accountType: res.accountType,
    totalEquity: num(res.totalEquity),
    totalWalletBalance: num(res.totalWalletBalance),
    totalMarginBalance: num(res.totalMarginBalance),
    totalAvailableBalance: num(res.totalAvailableBalance),
    coins: (res.list ?? []).map((c) => ({
      coin: c.coin,
      walletBalance: num(c.walletBalance),
      equity: num(c.equity),
      availableToWithdraw: num(c.availableToWithdraw),
      usdValue: num(c.usdValue),
    })),
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
  }));
}

export interface SetLeverageArgs {
  category: Category;
  symbol: string;
  leverage: number;
  positionIdx?: number;
}

export async function setLeverage(cred: ApiCredentials, args: SetLeverageArgs): Promise<void> {
  await requestPrivate('POST', '/v5/position/set-leverage', {
    category: args.category,
    symbol: args.symbol,
    buyLeverage: String(args.leverage),
    sellLeverage: String(args.leverage),
    ...(args.positionIdx != null ? { positionIdx: args.positionIdx } : {}),
  }, cred);
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
    ...(symbol ? { symbol } : {}),
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
    'GET', '/v5/order/realtime', { category, ...(symbol ? { symbol } : {}) }, cred,
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
  })).filter((o) => o.orderStatus.toUpperCase() !== 'CANCELED' && o.orderStatus.toUpperCase() !== 'REJECTED');
}

export async function cancelOrder(cred: ApiCredentials, category: Category, orderId: string): Promise<void> {
  await requestPrivate('POST', '/v5/order/cancel', { category, orderId }, cred);
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