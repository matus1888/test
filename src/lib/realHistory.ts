// История реальных сделок: исполнения биржи → «циклы» (вход → выход).
// Хранится в localStorage (`real:history:v1`) — как бумажные позиции, но по реальному
// счёту. Раньше исполнения жили только в памяти вкладки (лента /live, REST 20 шт),
// и после срабатывания стопа/TP история не сохранялась — что и просили починить.
//
// ⚠️ `/v5/execution/list` НЕ отдаёт execPnl (поле пустое) — P&L считаем сами:
// по символу сумма номиналов входов против выходов; направление — по первому филлу.
// Частичные выходы (TP1 70% → TP2 20% → TP3 10%) — отдельные филлы с пометкой kind.

import type { Category } from '../api/bybit';
import type { ApiExecution } from '../api/privateApi';
import { nowBybitMs } from './clock';

/** Причина филла (вход или вид закрытия). */
export type RealExitKind =
  | 'entry'          // филл входа (открытие)
  | 'tp'             // тейк-профит (лимитка reduce-only / ручное в плюс)
  | 'stop'           // стоп (маркет снизу)
  | 'manual'         // ручное закрытие (reduceOnly market)
  | 'liq'            // ликвидация
  | 'unknown';       // не распознали

export interface RealTrade {
  id: string;
  symbol: string;
  category: Category;
  /** Сторона ИСПОЛНЕНИЯ (Buy — покупка, Sell — продажа). Направление сделки — по первому филлу. */
  side: 'Buy' | 'Sell';
  price: number;
  qty: number;
  /** Комиссия этого филла, $ (реальная, от биржи). */
  fee: number;
  kind: RealExitKind;
  execTime: number;
  execId: string;
}

/**
 * Настоящая сделка или нет. `/v5/execution/list` (и WS-топик `execution`) рядом с
 * торговыми филлами отдают служебные строки: `execType: "Funding"` — начисление
 * фандинга (orderType UNKNOWN, без orderLinkId). Это не покупка и не продажа,
 * а денежный поток; если принять его за сделку, номинал входа/выхода удваивается
 * и P&L по циклу становится фантомным (проверено на живом счёте 30.09.2026:
 * −91 $ вместо +1.8 $ по ENA и +586 $ по шорту XAU → «P&L сегодня +363 $»).
 */
export function isTradeExecution(e: { execType?: string }): boolean {
  const t = (e.execType ?? '').toLowerCase();
  return t === '' || t === 'trade';
}

// v2: в v1 попадали строки фандинга (execType Funding) — цифры P&L были фантомными.
// Хранилище переехало на новый ключ, история пересобирается из биржи заново.
const KEY = 'real:history:v2';
const CHANGED_EVENT = 'real:history:changed';

/** Распознать тип филла по orderLinkId и типу ордера. */
export function exitKindOf(e: ApiExecution): RealExitKind {
  if (e.orderLinkId?.startsWith('ent')) return 'entry';
  if (e.orderLinkId?.startsWith('tp')) return 'tp';
  if (e.orderLinkId?.startsWith('cl')) return 'manual';
  // Лимитка TP идёт как «Limit»; стоп-заявка в Bybit — Market (IOC).
  if (e.orderType?.toLowerCase().includes('market')) return 'stop';
  return 'tp';
}

/** Исполнение → запись истории. Дедупликация по execId делает стор идемпотентным. */
export function executionToTrade(e: ApiExecution): RealTrade {
  return {
    id: e.execId,
    symbol: e.symbol,
    category: 'linear',
    side: e.side,
    price: e.price,
    qty: e.qty,
    fee: e.fee,
    kind: exitKindOf(e),
    execTime: e.execTime,
    execId: e.execId,
  };
}

/** Дедупликация по execId при чтении из localStorage (защита от повторных филлов). */
function dedupe(list: RealTrade[]): RealTrade[] {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.execId) ? false : (seen.add(t.execId), true)));
}

export function loadRealHistory(): RealTrade[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const valid = arr.filter(
      (t): t is RealTrade =>
        typeof t === 'object' && t !== null
        && typeof (t as { id?: unknown }).id === 'string'
        && typeof (t as { symbol?: unknown }).symbol === 'string'
        && ((t as { side?: unknown }).side === 'Buy' || (t as { side?: unknown }).side === 'Sell'),
    );
    return dedupe(valid).sort((a, b) => b.execTime - a.execTime);
  } catch {
    return [];
  }
}

export function saveRealHistory(list: RealTrade[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(dedupe(list)));
  } catch {
    /* переполнено/приватный режим — работаем в памяти */
  }
}

export function emitRealHistoryChanged(): void {
  try {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

/** Объединить исполнения с уже сохранёнными: новые сверху, дубли по execId отбрасываются. */
export function mergeExecutions(current: RealTrade[], incoming: ApiExecution[], limit = 500): RealTrade[] {
  const byId = new Map(current.map((t) => [t.execId, t]));
  for (const e of incoming) {
    if (!e.execId || byId.has(e.execId)) continue;
    // Фандинг и прочие служебные строки сделками не являются.
    if (!isTradeExecution(e)) continue;
    const t = executionToTrade(e);
    if (!t.symbol || !(t.qty > 0) || !(t.price > 0)) continue;
    byId.set(e.execId, t);
  }
  return [...byId.values()].sort((a, b) => b.execTime - a.execTime).slice(0, limit);
}

/** Сгруппированные по символу филлы с рассчитанным P&L. */
export interface SymbolHistory {
  symbol: string;
  /** Направление сделки: сторона первого филла. */
  direction: 'long' | 'short';
  entries: number;
  exits: number;
  avgEntry: number;
  avgExit: number;
  qtyIn: number;
  qtyOut: number;
  notionalIn: number;
  notionalOut: number;
  fees: number;
  /** Реализованный P&L «вход→выход» МИНУС комиссии. */
  pnl: number;
  closedQty: number;
  /** Момент последнего филла цикла (≈ время закрытия сделки). */
  lastTime: number;
}

const sumN = (list: RealTrade[]) => list.reduce((a, t) => a + t.qty * t.price, 0);
const sumQ = (list: RealTrade[]) => list.reduce((a, t) => a + t.qty, 0);

/** Свернуть филлы в «циклы» по символам: вход против выхода, P&L = номинал − номинал − комиссии.
 *  В историю попадают ТОЛЬКО закрытые циклы: и вход, и выход (closedQty > 0). Открытая позиция
 *  (вход есть, выхода ещё нет) реализованного P&L не даёт — её подсчитывает живой uP&L счёта. */
export function bySymbolHistory(list: RealTrade[]): SymbolHistory[] {
  const groups = new Map<string, RealTrade[]>();
  for (const t of list) {
    const g = groups.get(t.symbol) ?? [];
    g.push(t);
    groups.set(t.symbol, g);
  }
  const out: SymbolHistory[] = [];
  for (const [symbol, ts] of groups) {
    ts.sort((a, b) => a.execTime - b.execTime); // старые первыми
    const first = ts[0];
    const direction: 'long' | 'short' = first.side === 'Buy' ? 'long' : 'short';
    const buys = ts.filter((t) => t.side === 'Buy');
    const sells = ts.filter((t) => t.side === 'Sell');
    const byIn = direction === 'long' ? buys : sells;
    const byOut = direction === 'long' ? sells : buys;
    const notionalIn = sumN(byIn);
    const notionalOut = sumN(byOut);
    const qtyIn = sumQ(byIn);
    const qtyOut = sumQ(byOut);
    const closedQty = Math.min(qtyIn, qtyOut);
    // Позиция ещё открыта (вход без выхода) — в реализованный P&L не входит.
    if (!(closedQty > 0)) continue;
    const fees = ts.reduce((a, t) => a + t.fee, 0);
    // long: прибыль = вход дешевле → номинал выхода больше номинала входа.
    // short: наоборот.
    const raw = direction === 'long' ? notionalOut - notionalIn : notionalIn - notionalOut;
    out.push({
      symbol,
      direction,
      entries: byIn.length,
      exits: byOut.length,
      avgEntry: qtyIn > 0 ? notionalIn / qtyIn : 0,
      avgExit: qtyOut > 0 ? notionalOut / qtyOut : 0,
      qtyIn,
      qtyOut,
      notionalIn,
      notionalOut,
      fees,
      pnl: raw - fees,
      closedQty,
      lastTime: ts.at(-1)?.execTime ?? 0,
    });
  }
  return out.sort((a, b) => b.avgExit - a.avgExit);
}

/** Сводка по истории: всего сделок, P&L, комиссии. */
export function realHistorySummary(list: RealTrade[]) {
  const bySymbol = bySymbolHistory(list);
  const pnl = bySymbol.reduce((a, s) => a + s.pnl, 0);
  const fees = bySymbol.reduce((a, s) => a + s.fees, 0);
  const closed = bySymbol.reduce((a, s) => a + s.closedQty, 0);
  return {
    symbols: bySymbol.length,
    trades: list.length,
    entries: list.filter((t) => t.kind === 'entry').length,
    exits: list.filter((t) => t.kind !== 'entry').length,
    pnl,
    fees,
    closed,
    bySymbol,
  };
}

/**
 * Начало «сегодня» (мс). Часы по умолчанию — выровненные по бирже: моменты
 * исполнений приходят с биржи, поэтому со сбитыми часами телефона «сегодня»
 * могло бы не совпасть с реальными сутками сделки.
 */
export function startOfToday(now = nowBybitMs()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** P&L циклов, закрытых сегодня (последний филл цикла — сегодня), за вычетом комиссий. */
export function todayRealPnl(list: RealTrade[], now = nowBybitMs()): number {
  const start = startOfToday(now);
  return bySymbolHistory(list)
    .filter((s) => s.lastTime >= start && s.lastTime <= now)
    .reduce((a, s) => a + s.pnl, 0);
}

/** P&L циклов, закрытых сегодня, с разбивкой по дням для будущего расширения. */
export function dailyRealPnl(list: RealTrade[]): { day: string; pnl: number }[] {
  const byDay = new Map<string, number>();
  for (const s of bySymbolHistory(list)) {
    const d = new Date(s.lastTime).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + s.pnl);
  }
  return [...byDay.entries()].map(([day, pnl]) => ({ day, pnl })).sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** P&L одной сделки «как закрытого цикла»: номиналы + комиссии (для пары филлов). */
export function realizedNet(notionalOut: number, notionalIn: number, fees: number): number {
  return notionalOut - notionalIn - fees;
}

// Событие для оповещения экземпляров хука в этой вкладке.
export function realHistoryEventName(): string {
  return CHANGED_EVENT;
}