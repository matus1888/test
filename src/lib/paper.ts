import type { Candle, Category, Interval } from '../api/bybit';
import type { TradePlan } from './tradePlan';

export type PaperDirection = 'long' | 'short';
export type CloseReason = 'stop' | 'breakeven' | 'tp1' | 'tp2' | 'tp3' | 'manual' | 'liq';

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
  type: 'tp1' | 'tp2' | 'tp3' | 'stop' | 'breakeven' | 'liq';
  price: number;
  time: number;
}

/**
 * Статусы бумажной позиции:
 * - `pending` — лимитная заявка выставлена, но цена до лимита ещё не дошла: позиции
 *   нет, денег в работе нет, P&L нулевой. Так же устроен реальный ордер на бирже.
 * - `open` — лимит исполнен, позиция в рынке.
 * - `closed` — позиция закрыта (P&L реализован).
 * - `cancelled` — заявку отменили, исполнения не было (сделок не было вовсе).
 */
export type PaperStatus = 'pending' | 'open' | 'closed' | 'cancelled';

export interface PaperPosition {
  id: string;
  symbol: string;
  category: Category;
  interval: Interval;
  direction: PaperDirection;
  /** Цена лимита (из плана, entryMid). Фактическая цена входа — она же. */
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
  /** Момент постановки заявки (для pending) либо входа (для старых записей). */
  openedAt: number;
  /** Вид входа: лимит по зоне (по умолчанию) или сразу по рынку. */
  entryKind?: EntryKind;
  /**
   * Момент исполнения лимита. Пока его нет — заявка висит в рынке, позиции не
   * существует: P&L нулевой, стоп/тейки не проверяются. У позиций, созданных до
   * появления лимитов, исполнение = openedAt (см. `filledAtOf`).
   */
  filledAt?: number;
  /** Плановый риск в $, зафиксированный при постановке заявки (для аналитики). */
  riskMoney?: number;
  /** Ноги частичного выхода (TP1/TP2), материализованные движком. */
  legs?: PaperLeg[];
  status: PaperStatus;
  closeReason?: CloseReason;
  closePrice?: number;
  closedAt?: number;
  /** Почему заявку сняли без исполнения (для ленты событий). */
  cancelReason?: 'manual' | 'stale';
}

/**
 * Момент исполнения лимита; `undefined` — заявка не исполнена: висит в рынке
 * (`pending`) или снята без сделок (`cancelled`). Позиции, записанные до появления
 * лимитов, считаем исполненными в `openedAt`: у них статусы `open`/`closed` и поля
 * `filledAt` ещё нет.
 */
export function filledAtOf(
  pos: Pick<PaperPosition, 'status' | 'openedAt' | 'filledAt'>,
): number | undefined {
  if (pos.filledAt != null) return pos.filledAt;
  return pos.status === 'pending' || pos.status === 'cancelled' ? undefined : pos.openedAt;
}

/** Заявка исполнена (позиция в рынке или была закрыта). */
export function isFilled(pos: Pick<PaperPosition, 'status' | 'openedAt' | 'filledAt'>): boolean {
  return filledAtOf(pos) != null;
}

export interface PaperEval {
  events: PaperEvent[];
  stopHit: boolean;
  /** Цена коснулась ликвидации (леверидж/маржа не удержали позицию). */
  liqHit: boolean;
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

/**
 * Цена лимита в рынке: до неё цена должна дойти, иначе входа нет. Лонг
 * исполняется, когда рынок опустился до лимита или ниже; шорт — поднялся до него
 * или выше. Ровно то же проверяет биржа для лимитной заявки.
 */
export function limitReached(
  pos: Pick<PaperPosition, 'direction' | 'entryPrice'>,
  price: number,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  return sideOf(pos.direction) === 1 ? price <= pos.entryPrice : price >= pos.entryPrice;
}

/** Насколько цена не дошла до лимита, в долях (0 = лимит достигнут). */
export function limitGap(
  pos: Pick<PaperPosition, 'direction' | 'entryPrice'>,
  price: number,
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return (sideOf(pos.direction) * (price - pos.entryPrice)) / pos.entryPrice;
}

/**
 * Ранний момент исполнения лимита: сперва история свечей (заявка могла исполниться,
 * пока вкладка была закрыта или сокет молчал), затем — живая цена. Берём более
 * ранний из двух. Возвращает `null`, если заявка ещё в рынке.
 *
 * Свечи фильтруются по `openedAt` — движение до постановки заявки не считается.
 */
export function fillTimeOf(
  pos: PaperPosition,
  candles: Candle[] | undefined,
  live: number | null,
  now?: number,
): number | null {
  const at = now ?? Date.now();
  let byCandle: number | null = null;
  for (const c of candles ?? []) {
    if (c.time < pos.openedAt) continue;
    if (limitReached(pos, c.low) || limitReached(pos, c.high)) {
      byCandle = c.time;
      break;
    }
  }
  const byLive = live != null && limitReached(pos, live) ? at : null;
  if (byCandle == null) return byLive;
  if (byLive == null) return byCandle;
  return Math.min(byCandle, byLive);
}

/** Заявки, которые ещё можно отменить: висят дольше TTL. */
export function isStaleLimit(pos: PaperPosition, ttlMs: number, now?: number): boolean {
  return pos.status === 'pending' && (now ?? Date.now()) - pos.openedAt > ttlMs;
}

/**
 * Сколько заявка может висеть в рынке. Заявка — не позиция: если цена не дошла до
 * лимита за сутки, сетап протух (тренд/уровни из плана уже не про этот рынок),
 * и держать её дальше опасно — она может исполниться вне контекста сигнала.
 * Снятие видно в портфеле и в ленте событий, не молча.
 */
export const LIMIT_TTL_MS = 24 * 3600 * 1000;

/**
 * Заявки к исполнению: список для `applyFill`. Чистая функция — вызывается на
 * каждом тике живых цен, поэтому обязана быть дешёвой и возвращать пустой
 * список, когда исполнять нечего.
 */
export function fillsFor(
  positions: PaperPosition[],
  candlesOf: (p: PaperPosition) => Candle[] | undefined,
  priceOf: (p: PaperPosition) => number | null,
  now?: number,
): { id: string; info: FillInfo }[] {
  const at = now ?? Date.now();
  const out: { id: string; info: FillInfo }[] = [];
  for (const p of positions) {
    if (p.status !== 'pending') continue;
    const t = fillTimeOf(p, candlesOf(p), priceOf(p), at);
    if (t != null) out.push({ id: p.id, info: { filledAt: t } });
  }
  return out;
}

/** Заявки, протухшие по TTL: список для `applyCancel` с причиной `stale`. */
export function staleLimits(
  positions: PaperPosition[],
  now?: number,
  ttlMs = LIMIT_TTL_MS,
): { id: string; reason: 'stale' }[] {
  return positions
    .filter((p) => isStaleLimit(p, ttlMs, now))
    .map((p) => ({ id: p.id, reason: 'stale' as const }));
}

/** Нейтральная оценка — для заявок в рынке: событий ещё не было. */
export function emptyEval(candles: Candle[] = []): PaperEval {
  return {
    events: [],
    stopHit: false,
    liqHit: false,
    maxTp: 0,
    mfeR: 0,
    maeR: 0,
    firstCandle: candles.length > 0 ? candles[0].time : null,
    partial: false,
  };
}

/**
 * Прогон свечей после входа: какие уровни задеты и в каком порядке. Стоп внутри одной
 * свечи считается раньше тейков. После TP1 стоп переносится в безубыток (цену входа):
 * касание безубытка закрывает позицию с нулевым результатом.
 *
 * Заявка в рынке (статус `pending`) не оценивается: позиции ещё нет. Свечи считаются
 * от момента исполнения лимита. Если исполнение найдено по самой свече (заявка
 * исполнилась внутри её тела, поле `filledAt` = открытию свечи), эта свеча
 * оценивается только по вредной стороне (ликвидация/стоп): её максимум мог быть
 * ДО исполнения, поэтому цели и MFE по ней не засчитываем — так оценка не завышает
 * результат. Исполнение по живой цене внутри forming-свечи такого эффекта не даёт:
 * отметки времени открытия свечи оно не совпадёт.
 */
export function evaluatePosition(pos: PaperPosition, candles: Candle[]): PaperEval {
  const filledAt = filledAtOf(pos);
  if (filledAt == null) return emptyEval(candles);
  const entryBarTime = pos.filledAt != null ? filledAt : null;
  const end = pos.status === 'closed' && pos.closedAt ? pos.closedAt : Number.POSITIVE_INFINITY;
  const rows = candles.filter((c) => c.time >= filledAt && c.time <= end);
  const risk = Math.abs(pos.entryPrice - pos.stop) || 1e-9;
  const side = sideOf(pos.direction);
  // Ликвидация изолированной маржи по текущему левериджу. Проверяется раньше стопа:
  // если свеча-гэп пробила и стоп, и ликвидацию, в реале первым сработает margin call.
  const liqP = liquidationPrice(pos);
  const events: PaperEvent[] = [];
  const seen = { tp1: false, tp2: false, tp3: false };
  let stopHit = false;
  let liqHit = false;
  let beActive = false;
  let mfe = 0;
  let mae = 0;
  for (const c of rows) {
    // Бар исполнения: вредная сторона в нём уже могла сработать, входная — нет.
    const entryBar = entryBarTime != null && c.time === entryBarTime;
    if (!entryBar) {
      const fav = side === 1 ? c.high - pos.entryPrice : pos.entryPrice - c.low;
      const adv = side === 1 ? pos.entryPrice - c.low : c.high - pos.entryPrice;
      if (fav / risk > mfe) mfe = fav / risk;
      if (adv / risk > mae) mae = adv / risk;
    }
    if (beActive) {
      // Безубыток после TP1: выход в ноль вместо стопа.
      const beTouched = side === 1 ? c.low <= pos.entryPrice : c.high >= pos.entryPrice;
      if (beTouched) {
        events.push({ type: 'breakeven', price: pos.entryPrice, time: c.time });
        break;
      }
    } else {
      if (liqP != null && (side === 1 ? c.low <= liqP : c.high >= liqP)) {
        events.push({ type: 'liq', price: liqP, time: c.time });
        liqHit = true;
        break;
      }
      const stopTouched = side === 1 ? c.low <= pos.stop : c.high >= pos.stop;
      if (stopTouched) {
        events.push({ type: 'stop', price: pos.stop, time: c.time });
        stopHit = true;
        break;
      }
    }
    if (entryBar) continue;
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
    liqHit,
    maxTp: seen.tp3 ? 3 : seen.tp2 ? 2 : seen.tp1 ? 1 : 0,
    mfeR: mfe,
    maeR: mae,
    firstCandle,
    partial: firstCandle != null && firstCandle > filledAt,
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

/**
 * Полный P&L: зафиксированное ногами + переоценка остатка по цене.
 *
 * Заявка в рынке (статус `pending`) даёт строгие нули: позиции ещё нет, поэтому
 * «мгновенной прибыли» на входе быть не может в принципе — даже если цена уже
 * отличается от лимита. Номинал и маржа возвращаются плановыми: они показывают,
 * сколько встанет в работу при исполнении.
 */
export function totalPnlOf(pos: PaperPosition, price: number): TotalPnl {
  const { notional, margin } = positionMetrics(pos);
  const filled = filledAtOf(pos);
  if (filled == null) {
    return {
      pnl: 0, pct: 0, pctMargin: 0, r: 0, fee: 0,
      net: 0, netPct: 0, netMarginPct: 0, netR: 0,
      notional, margin, booked: 0, remaining: 1,
    };
  }
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
    pctMargin: margin > 0 ? (gross / margin) * 100 : 0,
    r: gross / riskMoney,
    fee,
    net,
    netPct: pos.stake > 0 ? (net / pos.stake) * 100 : 0,
    netMarginPct: margin > 0 ? (net / margin) * 100 : 0,
    netR: net / riskMoney,
    notional,
    margin,
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
  if (ev.liqHit) {
    const e = ev.events.find((x) => x.type === 'liq');
    return { closeReason: 'liq', closePrice: e ? e.price : pos.entryPrice, closedAt: e ? e.time : Date.now(), legs };
  }
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

export interface FillInfo {
  /** Момент исполнения. */
  filledAt: number;
}

/**
 * Чистое применение исполнений лимитов: заявка в рынке → позиция в рынке.
 * Без изменений возвращает исходный массив (важно: вызывается на каждом тике
 * живых цен, запись должна возникать только при реальном переходе статуса).
 */
export function applyFill(
  positions: PaperPosition[],
  list: { id: string; info: FillInfo }[],
): PaperPosition[] {
  let changed = false;
  const next = positions.map((p) => {
    const f = list.find((x) => x.id === p.id);
    if (!f || p.status !== 'pending') return p;
    changed = true;
    return { ...p, status: 'open' as const, filledAt: f.info.filledAt };
  });
  return changed ? next : positions;
}

/** Чистое применение отмены заявок без исполнения. */
export function applyCancel(
  positions: PaperPosition[],
  list: { id: string; reason: 'manual' | 'stale' }[],
  time = Date.now(),
): PaperPosition[] {
  let changed = false;
  const next = positions.map((p) => {
    const f = list.find((x) => x.id === p.id);
    if (!f || p.status !== 'pending') return p;
    changed = true;
    return { ...p, status: 'cancelled' as const, cancelReason: f.reason, closedAt: time };
  });
  return changed ? next : positions;
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
  /** % к ставке (выделенному бюджету). */
  pct: number;
  /** % к марже (номинал/плечо) — реальная доходность с учётом плеча. */
  pctMargin: number;
  /** R-мультипл: прибыль в единицах риска. */
  r: number;
  /** Оценка комиссии за круг (вход + выход), $. */
  fee: number;
  /** Чистый результат с учётом комиссии, $. */
  net: number;
  /** Чистый % к ставке. */
  netPct: number;
  /** Чистый % к марже. */
  netMarginPct: number;
  /** Чистый R-мультипл. */
  netR: number;
  /** Номинал позиции, $. */
  notional: number;
  /** Занятая изолированная маржа = номинал / плечо, $. */
  margin: number;
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

/** Оценка комиссии за круг (вход + выход): 2 × номинал × ставка тейкера.
 *  Заявка без исполнения (висит в рынке или снята) комиссии не имеет: сделок
 *  не было — на бирже тоже ничего не списывают. */
export function feeOf(pos: PaperPosition): number {
  if (filledAtOf(pos) == null) return 0;
  const notional = Math.abs(pos.qty * pos.entryPrice);
  const rate = TAKER_FEE_RATE[pos.category] ?? TAKER_FEE_RATE.linear;
  const fee = 2 * notional * rate;
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/** Номинал и изолированная маржа позиции: маржа = номинал / плечо.
 *  НОМИНАЛ/ПЛЕЧО И СТАВКА НЕ МЕНЯЮТ ДОЛЛАРОВЫЙ P&L: он всегда (exit−entry)×qty.
 *  Плечо меняет занятую маржу и «реальный» процент дохода, ставка — лишь бюджет-гейт. */
export function positionMetrics(pos: Pick<PaperPosition, 'qty' | 'entryPrice' | 'leverage'>): { notional: number; margin: number } {
  const notional = Math.abs(pos.qty * pos.entryPrice);
  const margin = pos.leverage > 0 ? notional / pos.leverage : notional;
  return { notional, margin };
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

/** Допустимая доля пути до ликвидации, которую занимает стоп (см. maxSafeLeverage/liqToStopRatio). */
export const LIQ_SAFETY = 0.7;

/**
 * Насколько ликвидация дальше стопа: во сколько раз расстояние до ликвидации больше
 * расстояния до стопа. 1 — уровни совпадают; <1 — margin call случится раньше стопа.
 */
export function liqToStopRatio(
  entryPrice: number,
  stop: number,
  direction: PaperDirection,
  leverage: number,
  mmr = 0.005,
): number | null {
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  const liq = liquidationPrice({ direction, entryPrice, leverage }, mmr);
  const stopDist = Math.abs(entryPrice - stop);
  const liqDist = liq == null ? null : Math.abs(entryPrice - liq);
  if (liqDist == null || !(stopDist > Number.EPSILON)) return null;
  return liqDist / stopDist;
}

/**
 * Максимальное плечо, при котором стоп занимает не более `safety` доли пути до ликвидации
 * (т.е. ликвидация остаётся за стопом с запасом). null — проверить нельзя (нет стопа/цены).
 */
export function maxSafeLeverage(
  entryPrice: number,
  stop: number,
  direction: PaperDirection,
  safety = LIQ_SAFETY,
  mmr = 0.005,
): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stop) || stop <= 0) return null;
  const fs = direction === 'long' ? (entryPrice - stop) / entryPrice : (stop - entryPrice) / entryPrice;
  if (!Number.isFinite(fs) || fs <= 0 || !(safety > 0)) return null;
  if (direction === 'long') {
    // (1-1/L)/(1-mmr) <= 1 - fs/safety  =>  L <= 1/(1-(1-mmr)*(1-fs/safety))
    const denom = 1 - (1 - mmr) * (1 - fs / safety);
    return denom > 0 ? 1 / denom : null;
  }
  // (1/L - mmr)/(1+mmr) >= fs/safety  =>  L <= 1/((1+mmr)*fs/safety + mmr)
  const denom = (1 + mmr) * (fs / safety) + mmr;
  return denom > 0 ? 1 / denom : null;
}

/** P&L при цене выхода (грязными + чистыми с учётом комиссии). */
export function pnlOf(pos: PaperPosition, exitPrice: number): Pnl {
  const riskMoney = Math.abs(pos.entryPrice - pos.stop) * pos.qty || 1e-9;
  const pnl = (exitPrice - pos.entryPrice) * sideOf(pos.direction) * pos.qty;
  const fee = feeOf(pos);
  const net = pnl - fee;
  const { notional, margin } = positionMetrics(pos);
  return {
    pnl,
    pct: pos.stake > 0 ? (pnl / pos.stake) * 100 : 0,
    pctMargin: margin > 0 ? (pnl / margin) * 100 : 0,
    r: pnl / riskMoney,
    fee,
    net,
    netPct: pos.stake > 0 ? (net / pos.stake) * 100 : 0,
    netMarginPct: margin > 0 ? (net / margin) * 100 : 0,
    netR: net / riskMoney,
    notional,
    margin,
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
    case 'liq': return 'Ликвидация';
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
    case 'liq': return 'LIQ';
  }
}

export interface DraftKey {
  symbol: string;
  category: Category;
  interval: Interval;
  direction: PaperDirection;
}

export interface PortfolioLimits {
  /** Максимум открытых позиций одновременно. Тестовый режим: без ограничения (Infinity). */
  maxOpen: number;
  /** Дневной лимит чистого убытка закрытых позиций, $. */
  maxDailyLoss: number;
}

export const DEFAULT_LIMITS: PortfolioLimits = { maxOpen: Infinity, maxDailyLoss: 150 };

/** Параметры риска для входа (общие для страницы символа и быстрого входа из таблиц). */
export interface EntryOpts {
  deposit: number;
  riskPct: number;
  stake: number;
  leverage: number;
}

/**
 * Вид входа:
 * - `limit` — лимитная заявка по середине зоны (по умолчанию): позиции нет, пока
 *   цена не дошла до лимита;
 * - `market` — исполнение сразу по текущей котировке, ждать отката не нужно.
 */
export type EntryKind = 'limit' | 'market';

/** Что именно выбрал пользователь при входе: вид входа и цена (для рынка — текущая котировка). */
export interface EntryPick {
  kind: EntryKind;
  price?: number | null;
}

/** Цена входа: лимит — середина зоны из плана, рынок — текущая котировка. */
export function entryPriceFor(kind: EntryKind, plan: TradePlan, price?: number | null): number {
  if (kind === 'market' && typeof price === 'number' && Number.isFinite(price) && price > 0) return price;
  return plan.entryMid;
}

/**
 * Дистанция от фактической цены входа до стопа. У рыночного входа она больше
 * плановой (цена ушла от середины зоны), поэтому размер позиции считается от
 * неё: риск в $ остаётся тем же, а номинал и маржа растут.
 */
export function riskDistFor(entryPrice: number, plan: TradePlan): number {
  return Math.abs(entryPrice - plan.stop);
}

/** Суммарная занятая маржа открытых позиций (задействованный капитал). */
export function totalEngagedMargin(positions: PaperPosition[]): number {
  return positions.reduce(
    (a, p) => (p.status === 'open' ? a + positionMetrics(p).margin : a),
    0,
  );
}

/**
 * Маржа, которую заняли бы висящие заявки, если все исполнятся. В задействованный
 * капитал не входит (сделок ещё нет), но показывается отдельно — на бирже такая
 * заявка маржу резервирует, и это стоит видеть до исполнения.
 */
export function pendingMargin(positions: PaperPosition[]): number {
  return positions.reduce(
    (a, p) => (p.status === 'pending' ? a + positionMetrics(p).margin : a),
    0,
  );
}

/**
 * Единая проверка перед входом: риск, маржа, безопасность ликвидации, дубли/лимиты,
 * а также портфельный лимит — суммарная маржа открытых позиций не может превышать
 * размер депозита (портфеля). Возвращает причину блокировки или null, если вход разрешён.
 * Используется страницей символа и кнопками быстрого входа в таблицах — один источник правды.
 */
export function entryBlockReason(
  positions: PaperPosition[],
  draft: DraftKey,
  plan: TradePlan,
  opts: EntryOpts,
  entry?: EntryPick,
): string | null {
  if (plan.direction !== 'long' && plan.direction !== 'short') return 'Нет направленного сетапа';
  const kind = entry?.kind ?? 'limit';
  if (kind === 'market' && !(typeof entry?.price === 'number' && entry.price > 0)) {
    return 'Нет текущей цены — вход по рынку сейчас недоступен, ждём котировку';
  }
  const riskMoney = opts.deposit * (opts.riskPct / 100);
  if (!(riskMoney > 0)) return 'Укажи риск больше нуля';
  const entryPrice = entryPriceFor(kind, plan, entry?.price);
  const riskDist = riskDistFor(entryPrice, plan);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(riskDist) || riskDist <= 0) return 'Нет зоны входа';
  const qty = riskMoney / riskDist;
  const marginNeeded = (qty * entryPrice) / opts.leverage;
  if (marginNeeded > opts.stake) {
    return `Не хватает маржи: нужно ${marginNeeded.toFixed(2)} $ при ×${opts.leverage} — подними ставку или снизь риск`;
  }
  const ratio = liqToStopRatio(entryPrice, plan.stop, plan.direction, opts.leverage);
  if (ratio != null && ratio < 1 / LIQ_SAFETY) {
    const maxLev = maxSafeLeverage(entryPrice, plan.stop, plan.direction);
    return `Ликвидация ближе стопа: liq при ×${opts.leverage} раньше стопа. Максимально безопасное плечо ~×${maxLev == null ? '—' : Math.max(1, Math.floor(maxLev))}`;
  }
  // Портфельный лимит: задействованный капитал (сумма марж) не превышает депозит.
  if (opts.deposit > 0) {
    const engaged = totalEngagedMargin(positions);
    if (engaged + marginNeeded > opts.deposit) {
      const free = Math.max(0, opts.deposit - engaged);
      return `Задействованный капитал исчерпан: нужно ещё ${marginNeeded.toFixed(0)} $, свободно ${free.toFixed(0)} $ из ${opts.deposit.toFixed(0)} $`;
    }
  }
  return canOpenPosition(positions, draft);
}

/**
 * Собрать бумажную позицию или заявку из плана и параметров риска.
 *
 * По умолчанию (`limit`) — заявка по середине зоны: позиции ещё нет, она появится,
 * когда цена дойдёт до лимита (`fillTimeOf`), ровно как реальный лимитный ордер.
 * При `entry.kind === 'market'` — исполнение сразу по текущей котировке: позиция
 * открыта с момента создания, размер считается от фактической дистанции до стопа,
 * поэтому риск в $ тот же, а номинал/маржа — больше. Вызывать только после
 * entryBlockReason(...) === null.
 */
export function makePaperPosition(
  symbol: string,
  category: Category,
  interval: Interval,
  plan: TradePlan,
  opts: EntryOpts,
  entry?: EntryPick,
): PaperPosition {
  const riskMoney = opts.deposit * (opts.riskPct / 100);
  const kind = entry?.kind ?? 'limit';
  const entryPrice = entryPriceFor(kind, plan, entry?.price);
  const qty = riskMoney / riskDistFor(entryPrice, plan);
  const now = Date.now();
  return {
    id: uid(),
    symbol,
    category,
    interval,
    direction: plan.direction === 'short' ? 'short' : 'long',
    entryPrice,
    stake: opts.stake,
    leverage: opts.leverage,
    qty,
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: plan.tp2,
    tp3: plan.tp3,
    entryLow: plan.entryLow,
    entryHigh: plan.entryHigh,
    confidence: plan.confidence,
    riskMoney,
    entryKind: kind,
    openedAt: now,
    // Рыночный вход исполняется сразу: позиция открыта уже на следующем рендере.
    filledAt: kind === 'market' ? now : undefined,
    status: kind === 'market' ? 'open' : 'pending',
  };
}

/**
 * Проверка перед постановкой заявки: дубли, лимит открытых позиций, дневной лимит убытка.
 * Дублем считается и висящая заявка в рынке — второй лимит на тот же символ и
 * направление ждал бы того же касания и удваивал бы риск в одном движении.
 * Возвращает причину блокировки или null, если вход разрешён.
 */
export function canOpenPosition(
  positions: PaperPosition[],
  draft: DraftKey,
  now = Date.now(),
  limits: PortfolioLimits = DEFAULT_LIMITS,
): string | null {
  const dup = positions.some((p) =>
    (p.status === 'open' || p.status === 'pending')
    && p.symbol === draft.symbol
    && p.category === draft.category
    && p.interval === draft.interval
    && p.direction === draft.direction,
  );
  if (dup) return 'Уже есть открытая позиция или заявка в рынке по этому символу и направлению — дубль удваивает риск.';
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

/**
 * Закрыть все открытые бумажные позиции «по рынку» (по текущей цене `priceOf`).
 * Возвращает новый список: у каждой закрытой проставляется manual-закрытие.
 * Заявки, которые ещё не исполнились, не закрываются — они просто снимаются
 * (сделок не было). Чистая функция — хук применяет её одним update
 * (одна запись в localStorage).
 */
export function closeAllPositions(
  positions: PaperPosition[],
  priceOf: (p: PaperPosition) => number,
  time = Date.now(),
): PaperPosition[] {
  return positions.map((p) => {
    if (p.status === 'open') {
      return { ...p, status: 'closed' as const, closeReason: 'manual' as const, closePrice: priceOf(p), closedAt: time };
    }
    if (p.status === 'pending') {
      return { ...p, status: 'cancelled' as const, cancelReason: 'manual' as const };
    }
    return p;
  });
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
