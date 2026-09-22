import type { Candle, Category, Interval } from '../api/bybit';

export type PaperDirection = 'long' | 'short';
export type CloseReason = 'stop' | 'tp1' | 'tp2' | 'tp3' | 'manual';

export interface PaperEvent {
  type: 'tp1' | 'tp2' | 'tp3' | 'stop';
  price: number;
  time: number;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  category: Category;
  interval: Interval;
  direction: PaperDirection;
  entryPrice: number;
  stake: number;
  leverage: number;
  qty: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  entryLow: number;
  entryHigh: number;
  confidence: number;
  openedAt: number;
  status: 'open' | 'closed';
  closeReason?: CloseReason;
  closePrice?: number;
  closedAt?: number;
}

export interface PaperEval {
  events: PaperEvent[];
  stopHit: boolean;
  maxTp: 0 | 1 | 2 | 3;
  /** Максимальный ход в пользу позиции, в единицах риска. */
  mfeR: number;
  /** Максимальный ход против позиции, в единицах риска. */
  maeR: number;
  firstCandle: number | null;
  /** История свечей короче жизни позиции — ранние события могли потеряться. */
  partial: boolean;
}

export const sideOf = (d: PaperDirection): 1 | -1 => (d === 'long' ? 1 : -1);

/** Прогон свечей после входа: какие уровни задеты и в каком порядке. Стоп внутри одной свечи считается раньше тейков. */
export function evaluatePosition(pos: PaperPosition, candles: Candle[]): PaperEval {
  const end = pos.status === 'closed' && pos.closedAt ? pos.closedAt : Number.POSITIVE_INFINITY;
  const rows = candles.filter((c) => c.time >= pos.openedAt && c.time <= end);
  const risk = Math.abs(pos.entryPrice - pos.stop) || 1e-9;
  const side = sideOf(pos.direction);
  const events: PaperEvent[] = [];
  const seen = { tp1: false, tp2: false, tp3: false };
  let stopHit = false;
  let mfe = 0;
  let mae = 0;
  for (const c of rows) {
    const fav = side === 1 ? c.high - pos.entryPrice : pos.entryPrice - c.low;
    const adv = side === 1 ? pos.entryPrice - c.low : c.high - pos.entryPrice;
    if (fav / risk > mfe) mfe = fav / risk;
    if (adv / risk > mae) mae = adv / risk;
    const stopTouched = side === 1 ? c.low <= pos.stop : c.high >= pos.stop;
    if (stopTouched) {
      events.push({ type: 'stop', price: pos.stop, time: c.time });
      stopHit = true;
      break;
    }
    const levels = [['tp1', pos.tp1], ['tp2', pos.tp2], ['tp3', pos.tp3]] as const;
    for (const [key, lvl] of levels) {
      if (!seen[key] && (side === 1 ? c.high >= lvl : c.low <= lvl)) {
        seen[key] = true;
        events.push({ type: key, price: lvl, time: c.time });
      }
    }
  }
  const firstCandle = candles.length > 0 ? candles[0].time : null;
  return {
    events,
    stopHit,
    maxTp: seen.tp3 ? 3 : seen.tp2 ? 2 : seen.tp1 ? 1 : 0,
    mfeR: mfe,
    maeR: mae,
    firstCandle,
    partial: firstCandle != null && firstCandle > pos.openedAt,
  };
}

export interface SettleInfo {
  closeReason: CloseReason;
  closePrice: number;
  closedAt: number;
}

/** Авто-закрытие открытой позиции по свечам: стоп или TP3. TP1/TP2 остаются достигнутыми уровнями. */
export function settleOpen(pos: PaperPosition, candles: Candle[] | undefined): SettleInfo | null {
  if (pos.status !== 'open' || !candles || candles.length === 0) return null;
  const ev = evaluatePosition(pos, candles);
  if (ev.stopHit) {
    const e = ev.events.find((x) => x.type === 'stop');
    return { closeReason: 'stop', closePrice: pos.stop, closedAt: e ? e.time : Date.now() };
  }
  const tp3 = ev.events.find((x) => x.type === 'tp3');
  if (tp3) return { closeReason: 'tp3', closePrice: pos.tp3, closedAt: tp3.time };
  return null;
}

export interface Pnl {
  pnl: number;
  /** % к ставке. */
  pct: number;
  /** R-мультипл: прибыль в единицах риска. */
  r: number;
}

/** P&L при цене выхода. */
export function pnlOf(pos: PaperPosition, exitPrice: number): Pnl {
  const riskMoney = Math.abs(pos.entryPrice - pos.stop) * pos.qty || 1e-9;
  const pnl = (exitPrice - pos.entryPrice) * sideOf(pos.direction) * pos.qty;
  return { pnl, pct: pos.stake > 0 ? (pnl / pos.stake) * 100 : 0, r: pnl / riskMoney };
}

export function closeLabel(reason: CloseReason | undefined): string {
  switch (reason) {
    case 'stop': return 'Стоп';
    case 'tp1': return 'TP1';
    case 'tp2': return 'TP2';
    case 'tp3': return 'TP3';
    case 'manual': return 'Вручную';
    default: return '—';
  }
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} дн ${h % 24} ч`;
}

export function uid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fallback ниже */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
