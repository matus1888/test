import type { Candle } from '../api/bybit';
import type { Category } from '../api/bybit';
import { sanitizeCandles, type SymbolMetrics } from './metrics';

export type Direction = 'long' | 'short' | 'wait';

/** Минимальный счёт для направленного сетапа. Шортам планка выше:
 * на бэктесте шорты систематически хуже лонгов в обоих режимах рынка. */
export const LONG_MIN_SCORE = 4;
export const SHORT_MIN_SCORE = 5;

export interface TradePlan {
  direction: Direction;
  confidence: number; // 0..100
  regime: string;
  horizon: string;
  price: number;
  atr: number;
  ema20: number;
  ema50: number;
  recentHigh: number;
  recentLow: number;
  entryLow: number;
  entryHigh: number;
  entryMid: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskDist: number;
  rrTp1: number;
  rrTp2: number;
  rrTp3: number;
  summary: string;
  setup: string;
  risks: string[];
  invalidation: string[];
  checklist: string[];
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atrAbs(candles: Candle[], period = 14): number {
  const n = candles.length;
  const m = Math.min(period, n);
  let sum = 0;
  for (let i = n - m; i < n; i++) {
    const c = candles[i];
    const p = candles[Math.max(0, i - 1)];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return m > 0 ? sum / m : 0;
}

export function horizonForInterval(interval: string): string {
  if (['1', '3', '5', '15'].includes(interval)) return 'Скальп · удержание от минут до часов';
  if (['30', '60', '120'].includes(interval)) return 'Интрадей · удержание до суток';
  return 'Свинг · удержание дни–недели';
}

/**
 * Предупреждение, если старшие таймфреймы против направления: бэктест показывает,
 * что лонги против часового тренда теряют заметно больше (−0,30R против −0,11R).
 * Мягкий сигнал (не ворота): только строка в рисках, сетап не отменяется.
 */
export function htfRisk(
  tfPlans: { interval: string; plan: TradePlan | null }[],
  direction: Direction,
  higher: string[] = ['60', '120', '240'],
): string | null {
  if (direction === 'wait') return null;
  const opp: Direction = direction === 'long' ? 'short' : 'long';
  const against = tfPlans.filter(
    (t) => higher.includes(t.interval) && t.plan != null && t.plan.direction === opp,
  ).length;
  if (against >= 2) {
    return `Старшие таймфреймы против позиции (${against} из ${higher.length}): импульс ниже может не дотянуть до целей — безубыток после TP1 обязателен.`;
  }
  return null;
}

export function buildTradePlan(
  candles: Candle[],
  m: SymbolMetrics,
  category: Category,
  fundingRate: number | null,
  interval = '',
): TradePlan | null {
  const rows = sanitizeCandles(candles);
  const n = rows.length;
  if (n < 55 || !Number.isFinite(m.lastPrice) || m.lastPrice <= 0) return null;
  const closes = rows.map((c) => c.close);
  const price = closes[n - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const atr = atrAbs(rows, 14);
  const window20 = rows.slice(-20);
  const recentHigh = Math.max(...window20.map((c) => c.high));
  const recentLow = Math.min(...window20.map((c) => c.low));
  const horizon = horizonForInterval(interval);

  const up = price > e20 && e20 > e50 && m.trendSlopePct > 0;
  const down = price < e20 && e20 < e50 && m.trendSlopePct < 0;

  let longScore = 0;
  if (up) longScore += 2;
  if (m.trendSlopePct > 1) longScore += 1;
  if (m.trendR2 > 0.5) longScore += 1;
  if (m.rsi >= 45 && m.rsi <= 72) longScore += 1;
  if (m.momentumPct > 0) longScore += 1;
  if (m.volumeRatio > 0.7) longScore += 1;

  let shortScore = 0;
  if (down) shortScore += 2;
  if (m.trendSlopePct < -1) shortScore += 1;
  if (m.trendR2 > 0.5) shortScore += 1;
  if (m.rsi >= 28 && m.rsi <= 55) shortScore += 1;
  if (m.momentumPct < 0) shortScore += 1;
  if (m.volumeRatio > 0.7) shortScore += 1;

  const allowShort = category !== 'spot';
  let direction: Direction = 'wait';
  if (allowShort && shortScore > longScore && shortScore >= SHORT_MIN_SCORE) direction = 'short';
  else if (longScore > shortScore && longScore >= LONG_MIN_SCORE) direction = 'long';
  else if (!allowShort && longScore >= LONG_MIN_SCORE) direction = 'long';

  const best = direction === 'long' ? longScore : direction === 'short' ? shortScore : Math.max(longScore, shortScore);
  const confidence = Math.round(Math.min(92, Math.max(8, (best / 7) * 100 + (m.trendR2 > 0.6 ? 6 : 0))));

  const regime = up
    ? 'Восходящий тренд (цена > EMA20 > EMA50)'
    : down
      ? 'Нисходящий тренд (цена < EMA20 < EMA50)'
      : 'Флэт / смешанный режим — EMA переплетены';

  // Зона входа: между ценой и EMA20 (pullback), стоп за зоной + ATR-буфер
  const kStop = 1.8;
  let entryLow: number, entryHigh: number, stop: number, setup: string;
  if (direction === 'long') {
    entryLow = Math.min(price, e20);
    entryHigh = Math.max(price, e20);
    stop = entryLow - kStop * atr;
    setup = price > e20
      ? 'Покупка отката к EMA20 в сторону тренда. Лимитная зона вместо маркета.'
      : 'Цена под EMA20 — вход только после возврата выше EMA20 либо пробоя локального максимума.';
  } else if (direction === 'short') {
    entryLow = Math.min(price, e20);
    entryHigh = Math.max(price, e20);
    stop = entryHigh + kStop * atr;
    setup = price < e20
      ? 'Продажа отката к EMA20 в сторону тренда. Лимитная зона вместо маркета.'
      : 'Цена над EMA20 — вход только после возврата ниже EMA20 либо пробоя локального минимума.';
  } else {
    entryLow = recentLow;
    entryHigh = recentHigh;
    stop = price;
    setup = allowShort
      ? 'Режима нет: торговля от границ диапазона или пробой. Лонг выше максимума 20 свечей, шорт ниже минимума.'
      : 'Режима нет: только лонг от нижней границы диапазона либо пробой максимума 20 свечей.';
  }

  const entryMid = (entryLow + entryHigh) / 2;
  const riskDist = direction === 'wait' ? atr : Math.abs(entryMid - stop);
  const side = direction === 'short' ? -1 : 1;
  const tp1 = direction === 'wait' ? recentHigh : entryMid + side * 1 * riskDist;
  const tp2 = direction === 'wait' ? recentHigh : entryMid + side * 2 * riskDist;
  const tp3 = direction === 'wait' ? recentHigh : entryMid + side * 3 * riskDist;

  const risks: string[] = [];
  if (m.atrPct > 5) risks.push(`Высокая волатильность: ATR ${m.atrPct.toFixed(2)}% от цены — стопы шире, размер позиции меньше.`);
  if (m.volumeRatio < 0.5) risks.push(`Слабое участие: объём ${m.volumeRatio.toFixed(2)}x от среднего — пробои могут быть ложными.`);
  if (direction === 'long' && m.rsi > 70) risks.push(`RSI ${m.rsi.toFixed(1)} — перекупленность, повышен риск покупки на пике.`);
  if (direction === 'short' && m.rsi < 30) risks.push(`RSI ${m.rsi.toFixed(1)} — перепроданность, повышен риск продажи на дне.`);
  if (m.trendR2 < 0.3 && direction !== 'wait') risks.push(`Слабый тренд (R² ${m.trendR2.toFixed(2)}) — вероятен флэт и пила.`);
  if (Math.abs(m.streak) >= 5) risks.push(`Серия из ${Math.abs(m.streak)} свечей подряд — движение растянуто, жди откат.`);
  if (fundingRate !== null && direction === 'long' && fundingRate < -0.0005)
    risks.push(`Фандинг отрицательный (${(fundingRate * 100).toFixed(4)}%) — лонг платят шорту, но сентимент медвежий.`);
  if (fundingRate !== null && direction === 'short' && fundingRate > 0.0005)
    risks.push(`Фандинг положительный (${(fundingRate * 100).toFixed(4)}%) — шорт платит лонгу, перенос через фандинг дорог.`);
  if (direction === 'long' && price >= recentHigh * 0.995)
    risks.push('Цена у максимума 20 свечей — пробой может не удержаться, часть фиксируй на TP1.');
  if (direction === 'short' && price <= recentLow * 1.005)
    risks.push('Цена у минимума 20 свечей — пробой может не удержаться, часть фиксируй на TP1.');
  if (risks.length === 0) risks.push('Явных красных флагов по метрикам нет, но стоп обязателен.');

  const invalidation = direction === 'wait'
    ? ['Закрепление выше максимума 20 свечей — смотреть лонг.', 'Закрепление ниже минимума 20 свечей — смотреть шорт (кроме спота).']
    : [
        `Закрытие свечи за стопом (${direction === 'long' ? 'ниже' : 'выше'} стопа) — выход без усреднения.`,
        'RSI развернулся против позиции + объём против тебя — досрочный выход.',
        'Потеря уровня EMA50 против позиции — план отменяется.',
      ];

  const checklist = [
    'Стоп выставлен сразу после входа, без ментальных стопов.',
    'Риск на сделку ≤ 1–2% депозита.',
    'Нет входа за 15 минут до/после новостей и фандинга.',
    'TP1 — снять часть и перевести стоп в безубыток.',
  ];

  const summary = direction === 'wait'
    ? `Направленного сетапа нет (${regime}). Работай от границ ${recentLow.toFixed(4)} / ${recentHigh.toFixed(4)} или жди пробой с закреплением.`
    : `${direction === 'long' ? 'Лонг' : 'Шорт'} по тренду (${regime}). Вход зоной, стоп по ATR, цели 1R/2R/3R. Уверенность ${confidence}%.`;

  const safe = (v: number) => (Number.isFinite(v) && v > 0 ? v : price);
  return {
    direction, confidence, regime, horizon, price,
    atr, ema20: e20, ema50: e50, recentHigh, recentLow,
    entryLow: safe(entryLow), entryHigh: safe(entryHigh), entryMid: safe(entryMid),
    stop: direction === 'wait' ? price : safe(stop),
    tp1: safe(tp1), tp2: safe(tp2), tp3: safe(tp3),
    riskDist: direction === 'wait' ? atr : Math.max(riskDist, atr * 0.5),
    rrTp1: 1, rrTp2: 2, rrTp3: 3,
    summary, setup, risks, invalidation, checklist,
  };
}
