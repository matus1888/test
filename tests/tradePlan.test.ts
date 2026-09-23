import { describe, expect, it } from 'vitest';
import { buildTradePlan, horizonForInterval, htfRisk, type TradePlan } from '../src/lib/tradePlan';
import { computeMetrics } from '../src/lib/metrics';
import { downSeries, flatSeries, randomSeries, upSeries } from './helpers/candles';

function planFor(series: ReturnType<typeof upSeries>, category = 'linear', fundingRate: number | null = 0.0001, interval = '5') {
  const m = computeMetrics(series);
  if (!m) throw new Error('need metrics');
  const p = buildTradePlan(series, m, category, fundingRate, interval);
  if (!p) throw new Error('need plan');
  return p;
}

describe('buildTradePlan: долгий сетап', () => {
  const plan = planFor(upSeries(200, 100, 0.5), 'linear', 0.0001, '15');

  it('направление и уверенность', () => {
    expect(plan.direction).toBe('long');
    expect(plan.confidence).toBeGreaterThanOrEqual(8);
    expect(plan.confidence).toBeLessThanOrEqual(92);
  });

  it('структура уровней: стоп ниже зоны, тейки по возрастанию, R-риски', () => {
    expect(Number.isFinite(plan.price)).toBe(true);
    expect(plan.stop).toBeLessThan(plan.entryLow);
    expect(plan.entryLow).toBeLessThanOrEqual(plan.entryHigh);
    expect(plan.tp1).toBeLessThan(plan.tp2);
    expect(plan.tp2).toBeLessThan(plan.tp3);
    expect(plan.riskDist).toBeCloseTo(plan.entryMid - plan.stop, 5);
    expect(plan.entryMid).toBeGreaterThan(plan.stop);
  });

  it('EMA-порядок для растущего ряда: price > EMA20 > EMA50', () => {
    expect(plan.price).toBeGreaterThan(plan.ema20);
    expect(plan.ema20).toBeGreaterThan(plan.ema50);
  });

  it('суммарный риск длинной сделки ~1.8×ATR от нижней границы зоны', () => {
    const atr = plan.atr;
    expect(Math.abs((plan.entryMid - plan.stop) - (1.8 * atr + (plan.entryHigh - plan.entryLow) / 2))).toBeLessThan(1e-9);
  });

  it('риск-сообщение при отрицательном фандинге у лонга', () => {
    const p = planFor(upSeries(200, 100, 0.5), 'linear', -0.001, '5');
    expect(p.risks.some((r) => r.includes('Фандинг отрицательный'))).toBe(true);
  });

  it('без риск-сообщения о фандинге при положительном фандинге', () => {
    expect(plan.risks.some((r) => r.includes('Фандинг'))).toBe(false);
  });
});

describe('buildTradePlan: короткий сетап (только не-spot)', () => {
  const plan = planFor(downSeries(200, 200, 0.5), 'linear', 0.001, '15');

  it('направление short и структура уровней зеркальна лонгу', () => {
    expect(plan.direction).toBe('short');
    expect(plan.stop).toBeGreaterThan(plan.entryHigh);
    expect(plan.tp1).toBeGreaterThan(plan.tp2);
    expect(plan.tp2).toBeGreaterThan(plan.tp3);
    expect(plan.entryMid).toBeLessThan(plan.stop);
  });

  it('положительный фандинг у шорта → риск-сообщение', () => {
    expect(plan.risks.some((r) => r.includes('Фандинг положительный'))).toBe(true);
  });

  it('на споте падающий ряд не даёт short', () => {
    const p = planFor(downSeries(200, 200, 0.5), 'spot', null, '5');
    expect(p.direction).not.toBe('short');
  });

  it('на споте растущий ряд даёт long', () => {
    const p = planFor(upSeries(200, 100, 0.5), 'spot', null, '5');
    expect(p.direction).toBe('long');
  });
});

describe('buildTradePlan: wait-режим', () => {
  const plan = planFor(flatSeries(200, 100), 'linear', null, '5');

  it('нет направления; стоп = цена, тейки = максимум диапазона', () => {
    expect(plan.direction).toBe('wait');
    expect(plan.stop).toBe(plan.price);
    expect(plan.tp1).toBe(plan.recentHigh);
    expect(plan.tp2).toBe(plan.recentHigh);
    expect(plan.tp3).toBe(plan.recentHigh);
    expect(plan.riskDist).toBe(plan.atr);
  });

  it('confidence в допустимых пределах даже для wait', () => {
    expect(plan.confidence).toBeGreaterThanOrEqual(8);
    expect(plan.confidence).toBeLessThanOrEqual(92);
  });

  it('инвалидация для wait описывает пробой границ', () => {
    expect(plan.invalidation.length).toBeGreaterThan(0);
    expect(plan.invalidation.join(' ')).toMatch(/максимума|минимума/);
  });
});

describe('buildTradePlan: EMA', () => {
  it('EMA константного ряда равна константе', () => {
    const m = computeMetrics(flatSeries(200, 100))!;
    const p = buildTradePlan(flatSeries(200, 100), m, 'linear', null, '5')!;
    expect(p.ema20).toBeCloseTo(100, 8);
    expect(p.ema50).toBeCloseTo(100, 8);
  });

  it('EMA запаздывает относительно цены на растущем ряду', () => {
    const plan = planFor(upSeries(200, 100, 0.5), 'linear', null, '5');
    expect(plan.ema20).toBeLessThan(plan.price);
    expect(plan.ema50).toBeLessThan(plan.ema20);
  });
});

describe('buildTradePlan: инварианты на случайных рядах', () => {
  it('все числовые поля конечны; тейки упорядочены по направлению; confidence в пределах 8..92', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const series = randomSeries(200, seed);
      const m = computeMetrics(series);
      if (!m) continue;
      const p = buildTradePlan(series, m, 'linear', seed % 2 ? 0.0001 : -0.0001, '5');
      if (!p) continue;
      expect(Number.isFinite(p.price)).toBe(true);
      expect(Number.isFinite(p.stop)).toBe(true);
      expect(Number.isFinite(p.atr)).toBe(true);
      expect(Number.isFinite(p.riskDist)).toBe(true);
      expect(p.confidence).toBeGreaterThanOrEqual(8);
      expect(p.confidence).toBeLessThanOrEqual(92);
      expect(Number.isFinite(p.entryLow)).toBe(true);
      expect(Number.isFinite(p.entryHigh)).toBe(true);
      if (p.direction === 'long') {
        expect(p.tp1).toBeLessThan(p.tp2);
        expect(p.tp2).toBeLessThan(p.tp3);
        expect(p.stop).toBeLessThanOrEqual(p.entryMid);
      } else if (p.direction === 'short') {
        expect(p.tp1).toBeGreaterThan(p.tp2);
        expect(p.tp2).toBeGreaterThan(p.tp3);
        expect(p.stop).toBeGreaterThanOrEqual(p.entryMid);
      }
    }
  });

  it('wait-план никогда не содержит NaN', () => {
    const series = randomSeries(200, 7);
    const m = computeMetrics(series)!;
    const p = buildTradePlan(series, m, 'linear', null, '5')!;
    const nums = ['price', 'stop', 'atr', 'riskDist', 'entryLow', 'entryHigh', 'entryMid', 'tp1', 'tp2', 'tp3'] as const;
    for (const k of nums) expect(Number.isFinite((p as Record<string, number>)[k])).toBe(true);
  });
});

describe('htfRisk: старшие таймфреймы', () => {
  const P = (direction: 'long' | 'short') => ({ direction }) as unknown as TradePlan;

  it('два и более старших против → предупреждение', () => {
    const tfs = [
      { interval: '60', plan: P('short') },
      { interval: '120', plan: P('short') },
      { interval: '240', plan: P('long') },
    ];
    expect(htfRisk(tfs, 'long')).toMatch(/старшие таймфреймы против/i);
  });

  it('один против — тихо', () => {
    const tfs = [
      { interval: '60', plan: P('short') },
      { interval: '120', plan: null },
      { interval: '240', plan: P('long') },
    ];
    expect(htfRisk(tfs, 'long')).toBeNull();
  });

  it('младшие интервалы не считаются', () => {
    const tfs = [
      { interval: '5', plan: P('short') },
      { interval: '15', plan: P('short') },
    ];
    expect(htfRisk(tfs, 'long')).toBeNull();
  });

  it('wait-направление → null', () => {
    expect(htfRisk([{ interval: '60', plan: P('short') }], 'wait')).toBeNull();
  });

  it('зеркально для шорта', () => {
    const tfs = [
      { interval: '60', plan: P('long') },
      { interval: '240', plan: P('long') },
    ];
    expect(htfRisk(tfs, 'short')).toMatch(/старшие таймфреймы против/i);
    expect(htfRisk(tfs, 'long')).toBeNull();
  });
});

describe('buildTradePlan: horizon', () => {
  it('маппинг интервалов на горизонты', () => {
    expect(horizonForInterval('1')).toMatch(/Скальп/);
    expect(horizonForInterval('5')).toMatch(/Скальп/);
    expect(horizonForInterval('30')).toMatch(/Интрадей/);
    expect(horizonForInterval('60')).toMatch(/Интрадей/);
    expect(horizonForInterval('D')).toMatch(/Свинг/);
    expect(horizonForInterval('W')).toMatch(/Свинг/);
  });
});

describe('buildTradePlan: входные защитные проверки', () => {
  it('null при меньше 55 свечей', () => {
    const series = upSeries(54);
    const m = computeMetrics(series)!;
    expect(buildTradePlan(series, m, 'linear', null, '5')).toBeNull();
  });

  it('мусорная свеча не отравляет план: уровни конечны (данные чистятся внутри)', () => {
    const series = upSeries(200);
    const badCandles = [...series];
    badCandles[199] = { ...badCandles[199], close: NaN };
    const m = computeMetrics(badCandles)!;
    const p = buildTradePlan(badCandles, m, 'linear', null, '5');
    expect(p).not.toBeNull();
    for (const k of ['price', 'ema20', 'ema50', 'atr', 'stop', 'entryLow', 'entryHigh', 'entryMid', 'tp1', 'tp2', 'tp3', 'riskDist'] as const) {
      expect(Number.isFinite(p![k])).toBe(true);
    }
  });
});