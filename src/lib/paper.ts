import type { Candle, Category, Interval } from '../api/bybit';

export type PaperDirection = 'long' | 'short';
export type CloseReason = 'stop' | 'breakeven' | 'tp1' | 'tp2' | 'tp3' | 'manual';

export interface PaperLeg {
  reason: 'tp1' | 'tp2';
  price: number;
  /** Доля позиции, закрытая ногой (0..1). */
  frac: number;
  time: number;
}

/**
 * Доли лесенки частичного выхода: TP1 → 70%, TP2 → 20%, раннер 10% до TP3.
 * На бэктесте (28 дней, majors, M5) лесенка даёт ≈+0,21R против −0,25R у схемы
 * «TP3-или-стоп»: TP1 достигается в ~62% сигналов, TP3 — лишь в ~19%.
 */
export const TP_FRACS = { tp1: 0.7, tp2: 0.2 } as const;
export const RUNNER_FRAC = 1 - TP_FRACS.tp1 - TP_FRACS.tp2;

export interface PaperEvent {
  type: 'tp1' | 'tp2' | 'tp3' | 'stop' | 'breakeven';
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
  /** Плановый риск в $, зафиксированный при входе (для будущей аналитики). */
  riskMoney?: number;
  /** Ноги частичного выхода (TP1/TP2), материализованные движком. */
  legs?: PaperLeg[];
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

/** Прогон свечей после входа: какие уровни задеты и в каком порядке. Стоп внутри одной свечи считается раньше тейков. После TP1 стоп переносится в безубыток (цену входа): касание безубытка закрывает позицию с нулевым результатом. */
export function evaluatePosition(pos: PaperPosition, candles: Candle[]): PaperEval {
  const end = pos.status === 'closed' && pos.closedAt ? pos.closedAt : Number.POSITIVE_INFINITY;
  const rows = candles.filter((c) => c.time >= pos.openedAt && c.time <= end);
  const risk = Math.abs(pos.entryPrice - pos.stop) || 1e-9;
  const side = sideOf(pos.direction);
  const events: PaperEvent[] = [];
  const seen = { tp1: false, tp2: false, tp3: false };
  let stopHit = false;
  let beActive = false;
  let mfe = 0;
  let mae = 0;
  for (const c of rows) {
    const fav = side === 1 ? c.high - pos.entryPrice : pos.entryPrice - c.low;
    const adv = side === 1 ? pos.entryPrice - c.low : c.high - pos.entryPrice;
    if (fav / risk > mfe) mfe = fav / risk;
    if (adv / risk > mae) mae = adv / risk;
    if (beActive) {
      // Безубыток после TP1: выход в ноль вместо стопа.
      const beTouched = side === 1 ? c.low <= pos.entryPrice : c.high >= pos.entryPrice;
      if (beTouched) {
        events.push({ type: 'breakeven', price: pos.entryPrice, time: c.time });
        break;
      }
    } else {
      const stopTouched = side === 1 ? c.low <= pos.stop : c.high >= pos.stop;
      if (stopTouched) {
        events.push({ type: 'stop', price: pos.stop, time: c.time });
        stopHit = true;
        break;
      }
    }
    const levels = [['tp1', pos.tp1], ['tp2', pos.tp2], ['tp3', pos.tp3]] as const;
    for (const [key, lvl] of levels) {
      if (!seen[key] && (side === 1 ? c.high >= lvl : c.low <= lvl)) {
        seen[key] = true;
        events.push({ type: key, price: lvl, time: c.time });
        if (key === 'tp1') beActive = true;
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
  closeReason?: CloseReason;
  closePrice?: number;
  closedAt?: number;
  /** Новые ноги частичного выхода (TP1/TP2) — позиция может остаться открытой. */
  legs: PaperLeg[];
}

/** Ноги частичного выхода из событий оценки: TP1 → 70%, TP2 → 20%. */
export function legsOf(ev: Pick<PaperEval, 'events'>): PaperLeg[] {
  const legs: PaperLeg[] = [];
  for (const e of ev.events) {
    if (e.type === 'tp1') legs.push({ reason: 'tp1', price: e.price, frac: TP_FRACS.tp1, time: e.time });
    else if (e.type === 'tp2') legs.push({ reason: 'tp2', price: e.price, frac: TP_FRACS.tp2, time: e.time });
  }
  return legs;
}

/** Доля позиции, ещё находящаяся в рынке (0..1). */
export function remainingFrac(pos: Pick<PaperPosition, 'legs'>): number {
  const taken = (pos.legs ?? []).reduce((a, l) => a + l.frac, 0);
  return Math.min(1, Math.max(0, 1 - taken));
}

/** Зафиксированный ногами P&L в $ (без комиссий — комиссия считается целиком за круг). */
export function bookedPnl(pos: PaperPosition): number {
  const side = sideOf(pos.direction);
  return (pos.legs ?? []).reduce((a, l) => a + l.frac * pos.qty * (l.price - pos.entryPrice) * side, 0);
}

export interface TotalPnl extends Pnl {
  /** Зафиксировано частями. */
  booked: number;
  /** Доля позиции ещё в рынке. */
  remaining: number;
}

/** Полный P&L: зафиксированное ногами + переоценка остатка по цене. */
export function totalPnlOf(pos: PaperPosition, price: number): TotalPnl {
  const remaining = remainingFrac(pos);
  const riskMoney = Math.abs(pos.entryPrice - pos.stop) * pos.qty || 1e-9;
  const mtm = (price - pos.entryPrice) * sideOf(pos.direction) * pos.qty * remaining;
  const booked = bookedPnl(pos);
  const gross = booked + mtm;
  const fee = feeOf(pos);
  const net = gross - fee;
  return {
    pnl: gross,
    pct: pos.stake > 0 ? (gross / pos.stake) * 100 : 0,
    r: gross / riskMoney,
    fee,
    net,
    netPct: pos.stake > 0 ? (net / pos.stake) * 100 : 0,
    netR: net / riskMoney,
    booked,
    remaining,
  };
}

/** Авто-закрытие открытой позиции по свечам: стоп, безубыток после TP1 или TP3. TP1/TP2 остаются достигнутыми уровнями. */
export function settleOpen(pos: PaperPosition, candles: Candle[] | undefined): SettleInfo | null {
  if (pos.status !== 'open' || !candles || candles.length === 0) return null;
  const ev = evaluatePosition(pos, candles);
  const have = new Set((pos.legs ?? []).map((l) => l.reason));
  const legs = legsOf(ev).filter((l) => !have.has(l.reason));
  if (ev.stopHit) {
    const e = ev.events.find((x) => x.type === 'stop');
    return { closeReason: 'stop', closePrice: pos.stop, closedAt: e ? e.time : Date.now(), legs };
  }
  const be = ev.events.find((x) => x.type === 'breakeven');
  if (be) return { closeReason: 'breakeven', closePrice: pos.entryPrice, closedAt: be.time, legs };
  const tp3 = ev.events.find((x) => x.type === 'tp3');
  if (tp3) return { closeReason: 'tp3', closePrice: pos.tp3, closedAt: tp3.time, legs };
  if (legs.length > 0) return { legs };
  return null;
}

/**
 * Чистое применение материализации к списку позиций: слияние новых ног
 * и закрытий. Возвращает исходный массив, если изменений нет.
 */
export function applySettle(
  positions: PaperPosition[],
  list: { id: string; info: SettleInfo }[],
): PaperPosition[] {
  let changed = false;
  const next = positions.map((p) => {
    const f = list.find((x) => x.id === p.id);
    if (!f || p.status !== 'open') return p;
    changed = true;
    const have = new Set((p.legs ?? []).map((l) => l.reason));
    const legs = [...(p.legs ?? [])];
    for (const l of f.info.legs) {
      if (!have.has(l.reason)) {
        have.add(l.reason);
        legs.push(l);
      }
    }
    if (!f.info.closeReason) return { ...p, legs };
    return {
      ...p,
      legs,
      status: 'closed' as const,
      closeReason: f.info.closeReason,
      closePrice: f.info.closePrice,
      closedAt: f.info.closedAt,
    };
  });
  return changed ? next : positions;
}

export interface Pnl {
  pnl: number;
  /** % к ставке. */
  pct: number;
  /** R-мультипл: прибыль в единицах риска. */
  r: number;
  /** Оценка комиссии за круг (вход + выход), $. */
  fee: number;
  /** Чистый результат с учётом комиссии, $. */
  net: number;
  /** Чистый % к ставке. */
  netPct: number;
  /** Чистый R-мультипл. */
  netR: number;
}

/**
 * Типичные тейкер-комиссии Bybit (доля от номинала за одну сторону).
 * Бумажные входы/выходы — по рынку, поэтому считаем по тейкеру:
 * спот 0,1%, линейные/инверсные фьючерсы 0,055%, опционы 0,03%.
 */
export const TAKER_FEE_RATE: Record<Category, number> = {
  spot: 0.001,
  linear: 0.00055,
  inverse: 0.00055,
  option: 0.0003,
};

/** Оценка комиссии за круг (вход + выход): 2 × номинал × ставка тейкера. */
export function feeOf(pos: PaperPosition): number {
  const notional = Math.abs(pos.qty * pos.entryPrice);
  const rate = TAKER_FEE_RATE[pos.category] ?? TAKER_FEE_RATE.linear;
  const fee = 2 * notional * rate;
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/**
 * Ориентировочная цена ликвидации для изолированной маржи.
 * Маржа на единицу = entry/leverage; ликвидация, когда убыток съедает маржу
 * за вычетом поддерживающей маржи (MM = liq × mmr, по умолчанию MMR 0,5% —
 * первый тир риск-лимитов Bybit для большинства USDT-перпов):
 * лонг — liq = entry·(1−1/lev)/(1−mmr), шорт — liq = entry·(1+1/lev)/(1+mmr).
 * Это оценка: реальная цена зависит от тира риск-лимита и может отличаться.
 */
export function liquidationPrice(pos: Pick<PaperPosition, 'direction' | 'entryPrice' | 'leverage'>, mmr = 0.005): number | null {
  const e = pos.entryPrice;
  const lev = pos.leverage;
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(lev) || lev <= 0) return null;
  if (!Number.isFinite(mmr) || mmr < 0 || mmr >= 1) return null;
  const liq = sideOf(pos.direction) === 1
    ? (e * (1 - 1 / lev)) / (1 - mmr)
    : (e * (1 + 1 / lev)) / (1 + mmr);
  return Number.isFinite(liq) && liq >= 0 ? liq : null;
}

/** P&L при цене выхода (грязными + чистыми с учётом комиссии). */
export function pnlOf(pos: PaperPosition, exitPrice: number): Pnl {
  const riskMoney = Math.abs(pos.entryPrice - pos.stop) * pos.qty || 1e-9;
  const pnl = (exitPrice - pos.entryPrice) * sideOf(pos.direction) * pos.qty;
  const fee = feeOf(pos);
  const net = pnl - fee;
  return {
    pnl,
    pct: pos.stake > 0 ? (pnl / pos.stake) * 100 : 0,
    r: pnl / riskMoney,
    fee,
    net,
    netPct: pos.stake > 0 ? (net / pos.stake) * 100 : 0,
    netR: net / riskMoney,
  };
}

export function closeLabel(reason: CloseReason | undefined): string {
  switch (reason) {
    case 'stop': return 'Стоп';
    case 'breakeven': return 'Безубыток';
    case 'tp1': return 'TP1';
    case 'tp2': return 'TP2';
    case 'tp3': return 'TP3';
    case 'manual': return 'Вручную';
    default: return '—';
  }
}

/** Короткая подпись события позиции для ленты и таблицы. */
export function eventLabel(type: PaperEvent['type']): string {
  switch (type) {
    case 'tp1': return 'TP1';
    case 'tp2': return 'TP2';
    case 'tp3': return 'TP3';
    case 'stop': return 'Стоп';
    case 'breakeven': return 'Б/У';
  }
}

export interface DraftKey {
  symbol: string;
  category: Category;
  interval: Interval;
  direction: PaperDirection;
}

export interface PortfolioLimits {
  /** Максимум открытых позиций одновременно. */
  maxOpen: number;
  /** Дневной лимит чистого убытка закрытых позиций, $. */
  maxDailyLoss: number;
}

export const DEFAULT_LIMITS: PortfolioLimits = { maxOpen: 5, maxDailyLoss: 150 };

/**
 * Проверка перед открытием: дубли, лимит открытых позиций, дневной лимит убытка.
 * Возвращает причину блокировки или null, если вход разрешён.
 */
export function canOpenPosition(
  positions: PaperPosition[],
  draft: DraftKey,
  now = Date.now(),
  limits: PortfolioLimits = DEFAULT_LIMITS,
): string | null {
  const dup = positions.some((p) =>
    p.status === 'open'
    && p.symbol === draft.symbol
    && p.category === draft.category
    && p.interval === draft.interval
    && p.direction === draft.direction,
  );
  if (dup) return 'Уже есть открытая позиция по этому символу и направлению — дубль удваивает риск.';
  const openCount = positions.filter((p) => p.status === 'open').length;
  if (openCount >= limits.maxOpen) return `Лимит открытых позиций (${limits.maxOpen}) — дождись развязки или закрой вручную.`;
  const dayAgo = now - 24 * 3600 * 1000;
  let dayNet = 0;
  for (const p of positions) {
    if (p.status === 'closed' && (p.closedAt ?? 0) >= dayAgo) {
      dayNet += totalPnlOf(p, p.closePrice ?? p.entryPrice).net;
    }
  }
  if (dayNet < -Math.abs(limits.maxDailyLoss)) {
    return `Дневной лимит убытка (${limits.maxDailyLoss} $) исчерпан — новые входы завтра.`;
  }
  return null;
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
