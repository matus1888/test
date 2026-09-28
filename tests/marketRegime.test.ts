import { describe, expect, it } from 'vitest';
import { REGIME_THRESHOLDS, summarizeRegime, VERDICT_LABEL } from '../src/lib/marketRegime';
import type { SymbolMetrics } from '../src/lib/metrics';
import type { Row } from '../src/lib/screener';
import type { TradePlan } from '../src/lib/tradePlan';

const metrics = (over: Partial<SymbolMetrics> = {}): SymbolMetrics => ({
  lastPrice: 10,
  volatilityRange: 0.6,
  volatilityStd: 0.3,
  atrPct: 0.6,
  changePct: 1,
  momentumPct: 0.2,
  trendSlopePct: 0.01,
  trendR2: 0.8,
  streak: 3,
  rsi: 55,
  volumeRatio: 1.2,
  score: 8,
  ...over,
});

const plan = (over: Partial<TradePlan> = {}): TradePlan => ({
  direction: 'long',
  confidence: 80,
  regime: 'trend-up',
  horizon: 'Скальп',
  price: 10,
  atr: 0.33,
  ema20: 9.8,
  ema50: 9.6,
  recentHigh: 10.5,
  recentLow: 9.5,
  entryLow: 9.9,
  entryHigh: 10,
  entryMid: 10,
  stop: 9.4,
  riskDist: 0.6,
  tp1: 10.6,
  tp2: 11.2,
  tp3: 11.8,
  rrTp1: 1,
  rrTp2: 2,
  rrTp3: 3,
  summary: '',
  setup: '',
  risks: [],
  invalidation: [],
  checklist: [],
  ...over,
});

const row = (symbol: string, over: Partial<Row> = {}): Row => ({
  symbol,
  price: 10,
  turnover: 50_000_000,
  fundingRate: 0.0001,
  m: metrics(),
  direction: 'long',
  confidence: 80,
  plan: plan(),
  klineError: null,
  klineLoading: false,
  ...over,
});

/** Заполняет выборку до нужного объёма парами wait, чтобы дойти до порога minAnalysed. */
const pad = (n: number, over: Partial<SymbolMetrics> = {}): Row[] =>
  Array.from({ length: n }, (_, i) =>
    row(`PAD${i}USDT`, {
      direction: 'wait',
      confidence: null,
      plan: plan({ direction: 'wait' }),
      m: metrics({ changePct: -0.5, momentumPct: -0.1, atrPct: 0.5, ...over }),
    }));

describe('summarizeRegime', () => {
  it('мало данных — вывод делать рано', () => {
    const s = summarizeRegime([row('AAAUSDT'), row('BBBUSDT')]);
    expect(s.verdict).toBe('no-data');
    expect(s.analysed).toBe(2);
    expect(s.headline).toMatch(/2 символ/);
    expect(s.reasons[0]).toContain(String(REGIME_THRESHOLDS.minAnalysed));
  });

  it('нет направленных сетапов — лучше не входить', () => {
    const s = summarizeRegime(pad(40));
    expect(s.analysed).toBe(40);
    expect(s.setups).toBe(0);
    expect(s.verdict).toBe('stand-aside');
    expect(s.headline).toContain('нет совсем');
  });

  it('сетапов меньше порога — входить не в что', () => {
    const rows = [
      row('AAAUSDT'),
      row('BBBUSDT', { direction: 'short', plan: plan({ direction: 'short' }) }),
      ...pad(38),
    ];
    const s = summarizeRegime(rows);
    expect(s.setups).toBe(2);
    expect(s.verdict).toBe('stand-aside');
    expect(s.headline).toContain('всего 2');
  });

  it('перекос в шорты — лучше не входить (главный сигнал)', () => {
    const shorts = Array.from({ length: 7 }, (_, i) =>
      row(`S${i}USDT`, {
        direction: 'short',
        confidence: 80,
        plan: plan({ direction: 'short', stop: 10.6, riskDist: 0.6 }),
        m: metrics({ changePct: -2, momentumPct: -0.4 }),
      }));
    const rows = [...shorts, row('LONGUSDT'), ...pad(40)];
    const s = summarizeRegime(rows);
    expect(s.shorts).toBe(7);
    expect(s.longs).toBe(1);
    expect(s.shortShare).toBeCloseTo(0.875, 6);
    expect(s.verdict).toBe('stand-aside');
    expect(s.headline).toContain('Перекос в шорты');
    expect(s.action).toContain('не входить');
    // Ссылка на бэктест обязательна: это обоснование вердикта, а не просто «так feels».
    expect(s.reasons.some((r) => r.includes('Бэктест'))).toBe(true);
  });

  it('перекос в шорты учитывает уже открытые шорты', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      row(`S${i}USDT`, { direction: 'short', plan: plan({ direction: 'short' }) }));
    const s = summarizeRegime([...shorts, ...pad(40)], { long: 0, short: 2 });
    expect(s.reasons.some((r) => r.includes('уже открыто шортов: 2'))).toBe(true);
  });

  it('порог перекоса — ровно 60% шортов (7 из 10)', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      row(`S${i}USDT`, { direction: 'short', plan: plan({ direction: 'short' }) }));
    const longs = Array.from({ length: 4 }, (_, i) => row(`L${i}USDT`));
    const s = summarizeRegime([...shorts, ...longs, ...pad(40)]);
    expect(s.shortShare).toBeCloseTo(0.6, 6);
    expect(s.verdict).toBe('stand-aside');
  });

  it('чуть ниже порога — уже не «перекос в шорты», а осторожно', () => {
    const shorts = Array.from({ length: 5 }, (_, i) =>
      row(`S${i}USDT`, { direction: 'short', plan: plan({ direction: 'short' }) }));
    const longs = Array.from({ length: 5 }, (_, i) => row(`L${i}USDT`));
    const s = summarizeRegime([...shorts, ...longs, ...pad(40)]);
    expect(s.verdict).toBe('cautious');
    expect(s.headline).toContain('явного перекоса нет');
  });

  it('перекос в лонги — входить можно', () => {
    const longs = Array.from({ length: 8 }, (_, i) => row(`L${i}USDT`));
    const s = summarizeRegime([...longs, row('S0USDT', { direction: 'short', plan: plan({ direction: 'short' }) }), ...pad(40)]);
    expect(s.verdict).toBe('go');
    expect(s.headline).toContain('Перекос в лонги');
    expect(s.action).toContain('Входить можно');
    expect(VERDICT_LABEL.go).toBe('Входить можно');
  });

  it('высокая волатильность понижает «входить можно» до «осторожно»', () => {
    const longs = Array.from({ length: 8 }, (_, i) =>
      row(`L${i}USDT`, { m: metrics({ atrPct: 3.2 }) }));
    // Медиана считается по всей выборке, поэтому и «фон» должен быть волатильным.
    const s = summarizeRegime([...longs, ...pad(40, { atrPct: 3.4 })]);
    expect(s.verdict).toBe('cautious');
    expect(s.headline).toContain('волатильно');
    expect(s.reasons.some((r) => r.includes('медианный ATR'))).toBe(true);
  });

  it('вялый рынок тоже не даёт зелёный свет', () => {
    const longs = Array.from({ length: 8 }, (_, i) =>
      row(`L${i}USDT`, { m: metrics({ atrPct: 0.1 }) }));
    const s = summarizeRegime([...longs, ...pad(40, { atrPct: 0.12 })]);
    expect(s.verdict).toBe('cautious');
    expect(s.headline).toContain('рынок вялый');
  });

  it('статистика по сторонам и выборке', () => {
    const rows = [
      row('L0USDT', { confidence: 90 }),
      row('L1USDT', { confidence: 70, fundingRate: 0.0002 }),
      row('S0USDT', {
        direction: 'short',
        confidence: 60,
        plan: plan({ direction: 'short' }),
        fundingRate: 0.0003,
        m: metrics({ changePct: -2, momentumPct: -0.4 }),
      }),
      ...pad(30),
    ];
    const s = summarizeRegime(rows);
    expect(s.longs).toBe(2);
    expect(s.shorts).toBe(1);
    expect(s.avgConfLong).toBeCloseTo(80, 6);
    expect(s.avgConfShort).toBeCloseTo(60, 6);
    expect(s.rising).toBe(2);   // два лонга с changePct > 0
    expect(s.falling).toBe(31); // один шорт + 30 pad
    expect(s.strongCount).toBe(2); // 90 и 70 (порог 70 включительно)
    expect(s.avgFunding).toBeCloseTo((0.0001 + 0.0002 + 0.0003 + 0.0001 * 30) / 33, 10);
  });

  it('пустая выборка не падает', () => {
    const s = summarizeRegime([]);
    expect(s.verdict).toBe('no-data');
    expect(s.setups).toBe(0);
    expect(s.avgConfLong).toBeNull();
    expect(s.medianAtr).toBeNull();
    expect(s.strongLongs).toEqual([]);
  });

  it('топ-3 сторон отсортированы по приоритету', () => {
    // Приоритет падает с уверенностью, растёт с R² и объёмом.
    const strong = row('STRONGUSDT', { confidence: 95, m: metrics({ trendR2: 0.95, volumeRatio: 2 }) });
    const mid = row('MIDUSDT', { confidence: 85 });
    const weak = row('WEAKUSDT', { confidence: 60, m: metrics({ trendR2: 0.6, volumeRatio: 0.95 }) });
    const s = summarizeRegime([...pad(40), weak, mid, strong]);
    expect(s.strongLongs.map((r) => r.symbol)).toEqual(['STRONGUSDT', 'MIDUSDT', 'WEAKUSDT']);
  });
});
