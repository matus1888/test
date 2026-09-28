// Разбор приватных кадров Bybit (position / order / execution / wallet) и их слияние
// со снимком REST. Чистые функции: их можно тестировать без сокета и без ключей.

import type { ActiveOrder, ApiPosition, WalletBalance } from '../api/privateApi';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const optional = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Позиция закрыта, когда размер стал нулевым: Bybit шлёт size "0" вместо удаления строки. */
export function isOpenPosition(row: { size: number }): boolean {
  return row.size > 0;
}

/** `position.{linear,spot,…}` → позиция в формате REST-снимка. */
export function parseWsPosition(data: unknown): ApiPosition | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const symbol = str(d.symbol);
  if (!symbol) return null;
  return {
    symbol,
    side: (str(d.side) || 'Buy') as ApiPosition['side'],
    size: num(d.size),
    avgPrice: num(d.entryPrice),
    markPrice: num(d.markPrice),
    leverage: num(d.leverage) || 1,
    positionIdx: num(d.positionIdx),
    liqPrice: optional(d.liqPrice),
    takeProfit: optional(d.takeProfit),
    stopLoss: optional(d.stopLoss),
    unrealisedPnl: num(d.unrealisedPnl),
    positionStatus: str(d.positionStatus) || (num(d.size) > 0 ? 'Normal' : ''),
  };
}

/** Ордер в формате таблицы активных ордеров. */
export function parseWsOrder(data: unknown): ActiveOrder | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const orderId = str(d.orderId);
  if (!orderId) return null;
  return {
    orderId,
    orderLinkId: d.orderLinkId ? str(d.orderLinkId) : undefined,
    symbol: str(d.symbol),
    side: (str(d.side) || 'Buy') as ActiveOrder['side'],
    orderType: str(d.orderType),
    qty: num(d.qty),
    price: num(d.price),
    orderStatus: str(d.orderStatus),
    stopLoss: optional(d.stopLoss),
    takeProfit: optional(d.takeProfit),
    timeInForce: d.timeInForce ? str(d.timeInForce) : undefined,
  };
}

/** Bybit пишет и «Cancelled», и «Canceled» — терминальные статусы убираем оба. */
const TERMINAL = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'deactivated']);

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL.has(status.toLowerCase());
}

/** Исполнение (fill) — для ленты на `/live`. */
export interface ApiFill {
  execId: string;
  orderId: string;
  symbol: string;
  side: string;
  execPrice: number;
  execQty: number;
  execFee: number;
  execPnl: number;
  execType: string;
  execTime: number;
  orderType: string;
  stopOrderType: string;
  isMaker: boolean;
}

export function parseWsExecution(data: unknown): ApiFill | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const execId = str(d.execId);
  const symbol = str(d.symbol);
  if (!execId || !symbol) return null;
  return {
    execId,
    orderId: str(d.orderId),
    symbol,
    side: str(d.side),
    execPrice: num(d.execPrice),
    execQty: num(d.execQty),
    execFee: num(d.execFee),
    execPnl: num(d.execPnl),
    execType: str(d.execType),
    execTime: num(d.execTime),
    orderType: str(d.orderType),
    stopOrderType: str(d.stopOrderType),
    isMaker: d.isMaker === true,
  };
}

const posKey = (p: { symbol: string; positionIdx: number }) => `${p.symbol}:${p.positionIdx}`;

/**
 * Слияние кадра `position` со списком: нулевые позиции удаляются, остальные
 * заменяются целиком (в кадре Bybit присылает все изменённые поля позиции).
 * Возвращает новый список и разницу uP&L — её нужно прибавить к кошельку,
 * потому что событие `wallet` на движение uP&L не приходит (см. документацию).
 */
export function mergePositions(
  current: ApiPosition[],
  rows: ApiPosition[],
): { positions: ApiPosition[]; uplDelta: number } {
  const byKey = new Map(current.map((p) => [posKey(p), p]));
  let uplDelta = 0;
  for (const row of rows) {
    const key = posKey(row);
    const prev = byKey.get(key);
    uplDelta += row.unrealisedPnl - (prev?.unrealisedPnl ?? 0);
    if (!isOpenPosition(row)) {
      byKey.delete(key);
      continue;
    }
    byKey.set(key, row);
  }
  return { positions: [...byKey.values()], uplDelta };
}

/** Слияние кадра `order`: исполненные/отменённые/отклонённые из таблицы уходят. */
export function mergeOrders(current: ActiveOrder[], rows: ActiveOrder[]): ActiveOrder[] {
  const byId = new Map(current.map((o) => [o.orderId, o]));
  for (const row of rows) {
    if (isTerminalOrderStatus(row.orderStatus)) byId.delete(row.orderId);
    else byId.set(row.orderId, row);
  }
  return [...byId.values()];
}

/** Слияние кадра `wallet`. uP&L в нём есть всегда, но Bybit его шлёт не на каждое движение. */
export function mergeWallet(prev: WalletBalance, data: unknown): WalletBalance {
  const rows = Array.isArray(data) ? data : [data];
  const row = rows.find((r) => typeof r === 'object' && r !== null) as Record<string, unknown> | undefined;
  if (!row) return prev;
  const next: WalletBalance = { ...prev };
  const take = (field: keyof Pick<WalletBalance, 'totalWalletBalance' | 'totalMarginBalance' | 'totalEquity' | 'totalAvailableBalance' | 'totalInitialMargin'>) => {
    if (row[field] !== undefined) next[field] = num(row[field]);
  };
  take('totalWalletBalance');
  take('totalMarginBalance');
  take('totalEquity');
  take('totalAvailableBalance');
  take('totalInitialMargin');
  // totalMarginBalance = totalWalletBalance + totalPerpUPL ⇒ uP&L восстанавливаем из балансов,
  // если кадр принёс оба поля (движение uP&L событие `wallet` не генерирует — см. документацию).
  if (row.totalWalletBalance !== undefined && row.totalMarginBalance !== undefined) {
    const upl = num(row.totalMarginBalance) - num(row.totalWalletBalance);
    if (Number.isFinite(upl)) next.totalPerpUPL = upl;
  }
  if (Array.isArray(row.coin)) {
    next.coins = (row.coin as Record<string, unknown>[]).map((c) => ({
      coin: str(c.coin),
      walletBalance: num(c.walletBalance),
      equity: num(c.equity),
      availableToWithdraw: num(c.availableToWithdraw),
      usdValue: num(c.usdValue),
    }));
  }
  return next;
}

/** Поправить кошелёк на изменение uP&L (equity = баланс + uP&L для перпетуаров). */
export function applyUplDelta(prev: WalletBalance, delta: number): WalletBalance {
  if (!delta) return prev;
  return {
    ...prev,
    totalPerpUPL: prev.totalPerpUPL + delta,
    totalEquity: prev.totalEquity + delta,
    totalMarginBalance: prev.totalMarginBalance + delta,
  };
}

/** Лента исполнений: новые сверху, без дублей по execId, длина ограничена. */
export function pushFill(fills: ApiFill[], fill: ApiFill, limit = 20): ApiFill[] {
  return [fill, ...fills.filter((f) => f.execId !== fill.execId)].slice(0, limit);
}
