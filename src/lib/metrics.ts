import type { Candle } from '../api/bybit';

export interface SymbolMetrics {
  lastPrice: number;
  /** Средний диапазон (h-l)/c в % за окно */
  volatilityRange: number;
  /** Stddev лог-доходностей в % (за свечу) */
  volatilityStd: number;
  /** ATR(14) / price в % */
  atrPct: number;
  /** Изменение цены за всё окно в % */
  changePct: number;
  /** Изменение за последние 10 свечей в % */
  momentumPct: number;
  /** Наклон линейной регрессии close, норм. в % за окно */
  trendSlopePct: number;
  /** R² тренда 0..1 */
  trendR2: number;
  /** Подряд свечей в сторону тренда (+ рост / - падение) */
  streak: number;
  /** RSI(14) 0..100 */
  rsi: number;
  /** Последний объём / средний за 20 */
  volumeRatio: number;
  /** Композит для сортировки: сила тренда * уверенность + волатильность */
  score: number;
}

function linreg(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 3) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += values[i]; sxx += i * i; sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const mean = sy / n;
  let ssTot = 0, ssRes = 0;
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) {
    ssTot += (values[i] - mean) ** 2;
    ssRes += (values[i] - (intercept + slope * i)) ** 2;
  }
  return { slope, r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

/**
 * Санация свечей перед расчётом метрик и планов: отбрасывает свечи с нефинитным
 * или неположительным close (логарифм доходности иначе даёт NaN/-Inf),
 * перевёрнутые high/low чинит перестановкой, нефинитный объём — нулём.
 */
export function sanitizeCandles(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    if (!Number.isFinite(c.close) || c.close <= 0) continue;
    let high = Number.isFinite(c.high) ? c.high : c.close;
    let low = Number.isFinite(c.low) ? c.low : c.close;
    if (high < low) {
      const t = high;
      high = low;
      low = t;
    }
    const volume = Number.isFinite(c.volume) ? c.volume : 0;
    out.push({ ...c, high, low, volume });
  }
  return out;
}

export function computeMetrics(candles: Candle[]): SymbolMetrics | null {
  const rows = sanitizeCandles(candles);
  const n = rows.length;
  if (n < 10) return null;
  const closes = rows.map((c) => c.close);
  const lastPrice = closes[n - 1];
  const first = closes[0];

  let rangeSum = 0;
  let atrSum = 0;
  const atrN = Math.min(14, n);
  for (let i = 0; i < n; i++) {
    const c = rows[i];
    rangeSum += ((c.high - c.low) / c.close) * 100;
  }
  for (let i = n - atrN; i < n; i++) {
    const c = rows[i];
    const p = rows[Math.max(0, i - 1)];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrSum += tr;
  }

  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;

  const { slope, r2 } = linreg(closes);
  const k = Math.min(10, n);
  const momentumPct = ((closes[n - 1] / closes[n - k]) - 1) * 100;

  let streak = 0;
  for (let i = n - 1; i > 0; i--) {
    const d = Math.sign(closes[i] - closes[i - 1]);
    if (d === 0) continue;
    if (streak === 0) streak = d;
    else if (Math.sign(streak) === d) streak += d;
    else break;
  }

  const vols = rows.map((c) => c.volume);
  const avg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);

  const volatilityRange = rangeSum / n;
  const volatilityStd = Math.sqrt(variance) * 100;
  const atrPct = (atrSum / atrN / lastPrice) * 100;
  const changePct = ((lastPrice / first) - 1) * 100;
  // Нормализация к первой цене окна (та же база, что у changePct):
  // зеркальные ряды получают симметричный тренд, без bias к упавшим монетам.
  const trendSlopePct = (slope * n / first) * 100;
  const volumeRatio = avg20 > 0 ? vols[n - 1] / avg20 : 0;

  const rawScore = Math.abs(trendSlopePct) * (0.3 + r2) + volatilityRange * 0.3 + Math.min(Math.abs(momentumPct), 20) * 0.2;
  const score = Number.isFinite(rawScore) ? rawScore : 0;

  return {
    lastPrice,
    volatilityRange,
    volatilityStd,
    atrPct,
    changePct,
    momentumPct,
    trendSlopePct,
    trendR2: r2,
    streak,
    rsi: rsi(closes),
    volumeRatio,
    score,
  };
}
