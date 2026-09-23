import type { Candle } from '../../src/api/bybit';

export interface CandleOpts {
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  turnover?: number;
  time?: number;
}

/** Свеча с разумными дефолтами: цена двигается от open к close, диапазон ±0.2. */
export function candle(i: number, close: number, opts: CandleOpts = {}): Candle {
  const open = opts.open ?? close - 0.1;
  const high = opts.high ?? Math.max(open, close) + 0.2;
  const low = opts.low ?? Math.min(open, close) - 0.2;
  return {
    time: opts.time ?? i * 60_000,
    open,
    high,
    low,
    close,
    volume: opts.volume ?? 100,
    turnover: opts.turnover ?? 100 * close,
  };
}

/** Ряд из n свечей с линейным ростом: start + i*step. */
export function upSeries(n = 200, start = 100, step = 0.5): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, start + i * step));
}

/** Ряд из n свечей с линейным спадом: start - i*step. */
export function downSeries(n = 200, start = 200, step = 0.5): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, start - i * step));
}

/** Плоский ряд с постоянной ценой. */
export function flatSeries(n = 200, price = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, price));
}

/** Ряд с заданными ценами закрытия: первые заполняются базовой ценой. */
export function fromCloses(closes: number[], base = 100, n = 200): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = i < n - closes.length ? base : closes[i - (n - closes.length)];
    out.push(candle(i, c));
  }
  return out;
}

/** Случайное блуждание (детерминированный seed для воспроизводимости). */
export function randomSeries(n = 200, seed = 42, start = 100): Candle[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  let p = start;
  return Array.from({ length: n }, (_, i) => {
    p += (rnd() - 0.5) * 0.5;
    return candle(i, p);
  });
}