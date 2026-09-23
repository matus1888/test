import { describe, expect, it } from 'vitest';
import { computeMetrics, type SymbolMetrics } from '../src/lib/metrics';
import { candle, downSeries, flatSeries, fromCloses, randomSeries, upSeries } from './helpers/candles';

const valid = (m: SymbolMetrics | null): SymbolMetrics => {
  expect(m).not.toBeNull();
  return m!;
};

describe('computeMetrics: базовые инварианты', () => {
  it('возвращает null при < 10 свечей', () => {
    expect(computeMetrics([])).toBeNull();
    expect(computeMetrics(upSeries(9))).toBeNull();
  });

  it('плоский ряд: нулевые тренд, скор-трендовая часть и изменение; RSI 50', () => {
    const m = valid(computeMetrics(flatSeries(200, 100)));
    // volatilityRange > 0: свечи хелпера имеют спред ±0.2 → средний диапазон 0.5% цены.
    expect(m.volatilityRange).toBeCloseTo(0.5, 6);
    expect(m.volatilityStd).toBe(0);
    expect(m.trendSlopePct).toBe(0);
    expect(m.trendR2).toBe(0);
    expect(m.momentumPct).toBe(0);
    expect(m.changePct).toBe(0);
    // Скор плоского ряда = только волатильная часть: range*0.3
    expect(m.score).toBeCloseTo(m.volatilityRange * 0.3, 10);
    expect(m.streak).toBe(0);
    expect(m.rsi).toBe(50);
    expect(m.volumeRatio).toBe(1);
  });

  it('короткий ряд (10–14 свечей): RSI-сенентинел 50, остальное конечно', () => {
    const m = valid(computeMetrics(upSeries(12)));
    expect(m.rsi).toBe(50);
    expect(Number.isFinite(m.score)).toBe(true);
  });
});

describe('computeMetrics: тренд и регрессия', () => {
  it('монотонный рост: положительный тренд, R²≈1, RSI=100', () => {
    const m = valid(computeMetrics(upSeries(200, 100, 0.5)));
    expect(m.trendSlopePct).toBeGreaterThan(0);
    expect(m.trendR2).toBeGreaterThan(0.999);
    expect(m.rsi).toBe(100);
    expect(m.momentumPct).toBeGreaterThan(0);
    expect(m.changePct).toBeGreaterThan(0);
  });

  it('монотонный спад: отрицательный тренд, R²≈1, RSI=0', () => {
    const m = valid(computeMetrics(downSeries(200, 200, 0.5)));
    expect(m.trendSlopePct).toBeLessThan(0);
    expect(m.trendR2).toBeGreaterThan(0.999);
    expect(m.rsi).toBe(0);
  });

  it('тренд и изменение за окно согласованы (одна база: первая цена окна)', () => {
    // Регрессия на идеальной прямой ≈ фактическому изменению цены.
    // Раньше тренд нормировался на последнюю цену → для растущего ряда давал ~0.5× от changePct.
    for (const series of [upSeries(200, 100, 0.5), downSeries(200, 200, 0.5)]) {
      const m = valid(computeMetrics(series));
      const ratio = m.trendSlopePct / m.changePct;
      expect(Math.abs(ratio - 1)).toBeLessThan(0.05);
    }
  });

  it('знак тренда совпадает со знаком изменения цены', () => {
    const up = valid(computeMetrics(upSeries(200)));
    const down = valid(computeMetrics(downSeries(200)));
    expect(Math.sign(up.trendSlopePct)).toBe(Math.sign(up.changePct));
    expect(Math.sign(down.trendSlopePct)).toBe(Math.sign(down.changePct));
  });
});

describe('computeMetrics: RSI на известной последовательности', () => {
  it('чередование +2/-1 в последних 14 переходах → RSI 66.67', () => {
    // Переходы: +2,-1 × 7 → g=14, l=7, rs=2 → RSI = 100 - 100/3
    const closes = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107];
    const m = valid(computeMetrics(fromCloses(closes, 100, 200)));
    expect(m.rsi).toBeCloseTo(66.6667, 3);
  });

  it('граничные значения 0 и 100 на монотонных рядах', () => {
    expect(valid(computeMetrics(upSeries(200))).rsi).toBe(100);
    expect(valid(computeMetrics(downSeries(200))).rsi).toBe(0);
  });
});

describe('computeMetrics: streak (семантика «переходов», дои пропускаются)', () => {
  it('ровно N зелёных подряд в конце плоского ряда', () => {
    const m = valid(computeMetrics(fromCloses([2, 3, 4], 1, 200)));
    expect(m.streak).toBe(3);
  });

  it('дои (flat-свечи) прерывают подсчёт только по развороту: [1,2,3,3,4,4,5] → 4', () => {
    // Документирует текущее поведение: считаются ненулевые переходы, дои пропускаются.
    const m = valid(computeMetrics(fromCloses([1, 2, 3, 3, 4, 4, 5], 1, 200)));
    expect(m.streak).toBe(4);
  });

  it('разворот обрывает серию: [1,2,3,2,1] → −2 (два спуска подряд)', () => {
    const m = valid(computeMetrics(fromCloses([1, 2, 3, 2, 1], 1, 200)));
    expect(m.streak).toBe(-2);
  });

  it('весь монотонный ряд из 200 свечей → 199 переходов', () => {
    expect(valid(computeMetrics(upSeries(200))).streak).toBe(199);
    expect(valid(computeMetrics(downSeries(200))).streak).toBe(-199);
  });
});

describe('computeMetrics: волатильность и ATR', () => {
  it('ATR% = TR/price для ряда без гэпов', () => {
    // candle(i, close) задаёт high=close+0.2, low=close-0.2, шаг цены 0.5 →
    // TR = max(0.4, |high-prev_close|=0.7, |low-prev_close|=0.3) = 0.7
    const series = upSeries(200, 100, 0.5);
    const m = valid(computeMetrics(series));
    const last = 199.5;
    expect(m.atrPct).toBeCloseTo((0.7 / last) * 100, 8);
    // Волатильность диапазона: среднее (high-low)/close по ряду
    const expectedRange = series.reduce((a, c) => a + ((c.high - c.low) / c.close) * 100, 0) / series.length;
    expect(m.volatilityRange).toBeCloseTo(expectedRange, 10);
  });

  it('volatilityStd: stddev лог-доходностей, в %', () => {
    const m = valid(computeMetrics(upSeries(200, 100, 0.5)));
    // Доходности log((100+0.5(i+1))/(100+0.5i)) — не константы, но положительные и конечные.
    expect(m.volatilityStd).toBeGreaterThan(0);
    expect(Number.isFinite(m.volatilityStd)).toBe(true);
  });
});

describe('computeMetrics: устойчивость к мусорным свечам', () => {
  it('мусорные свечи отфильтровываются: метрики конечны (score не NaN/-Inf)', () => {
    const ok = Array.from({ length: 60 }, (_, i) => candle(100 + i, 100 + i * 0.1));
    const garbage: ReturnType<typeof candle>[] = [
      { time: 1, open: 1, high: 0.5, low: 1.5, close: 0, volume: 10, turnover: 10 },
      { time: 2, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN, turnover: NaN },
      { time: 3, open: 1, high: 2, low: 1, close: -5, volume: 10, turnover: 10 },
      { time: 4, open: 1, high: 2, low: 1, close: 1.5, volume: -3, turnover: 10 },
      { time: 5, open: 1, high: Number.POSITIVE_INFINITY, low: 0.5, close: 1, volume: 10, turnover: 10 },
    ];
    const m = valid(computeMetrics([...garbage, ...ok]));
    expect(Number.isFinite(m.score)).toBe(true);
    expect(Number.isFinite(m.volatilityStd)).toBe(true);
    expect(Number.isFinite(m.trendSlopePct)).toBe(true);
    expect(Number.isFinite(m.rsi)).toBe(true);
    expect(Number.isFinite(m.volumeRatio)).toBe(true);
  });

  it('ряд, полностью состоящий из мусора, → null', () => {
    const junk = Array.from({ length: 50 }, (_, i) => ({
      time: i, open: 1, high: 0.5, low: 1.5, close: i % 3 === 0 ? 0 : NaN, volume: 1, turnover: 1,
    }));
    expect(computeMetrics(junk)).toBeNull();
  });
});

describe('computeMetrics: score', () => {
  it('всегда конечен на случайных рядах', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const m = valid(computeMetrics(randomSeries(200, seed)));
      expect(Number.isFinite(m.score)).toBe(true);
      expect(m.score).toBeGreaterThanOrEqual(0);
    }
  });
});