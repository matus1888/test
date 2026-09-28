import { describe, expect, it } from 'vitest';
import {
  SUSPICIOUS,
  hiddenReasonsCount,
  marginFor,
  splitSuspicious,
  suspicionsOf,
} from '../src/lib/pairFilter';
import type { Row } from '../src/lib/screener';
import type { SymbolMetrics } from '../src/lib/metrics';
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
  horizon: 'Скальп · удержание от минут до часов',
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
  tp1: 10.6,
  tp2: 11.2,
  tp3: 11.8,
  riskDist: 0.6,
  rrTp1: 1,
  rrTp2: 2,
  rrTp3: 3,
  summary: 'Лонг по тренду',
  setup: 'Покупка отката к EMA20',
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

// Параметры сессии: депозит 100, риск 2% → 2 $, плечо ×5, потолок маржи 100 $.
const OPTS = { riskMoney: 2, leverage: 5, stake: 100 };

describe('marginFor', () => {
  it('маржа = риск / дистанция до стопа × цена, делённая на плечо', () => {
    const r = row('AAUSDT', { plan: plan({ entryMid: 10, riskDist: 0.5 }) });
    // qty = 2 / 0.5 = 4 шт · 10 = 40 $ номинал / 5 = 8 $ маржа
    expect(marginFor(r, 2, 5)).toBeCloseTo(8, 6);
  });

  it('без направленного плана (wait) маржа неизвестна', () => {
    const r = row('AAUSDT', { direction: 'wait', confidence: null, plan: plan({ direction: 'wait' }) });
    expect(marginFor(r, 2, 5)).toBeNull();
  });

  it('битые параметры не дают деления на ноль', () => {
    const r = row('AAUSDT', { plan: plan({ riskDist: 0 }) });
    expect(marginFor(r, 2, 5)).toBeNull();
    expect(marginFor(row('AAUSDT'), 0, 5)).toBeNull();
    expect(marginFor(row('AAUSDT'), 2, 0)).toBeNull();
  });
});

describe('suspiciousOf', () => {
  it('нормальная пара: причин нет', () => {
    expect(suspicionsOf(row('AAUSDT'), OPTS)).toEqual([]);
  });

  it('мало ликвидности: оборот ниже порога', () => {
    const r = row('AAUSDT', { turnover: SUSPICIOUS.minTurnover - 1 });
    expect(suspicionsOf(r, OPTS)).toEqual(['liquidity']);
  });

  it('оборот ровно на пороге — не отсеиваем', () => {
    const r = row('AAUSDT', { turnover: SUSPICIOUS.minTurnover });
    expect(suspicionsOf(r, OPTS)).toEqual([]);
  });

  it('вялый ход: ATR ниже порога', () => {
    const r = row('AAUSDT', { m: metrics({ atrPct: 0.15 }) });
    expect(suspicionsOf(r, OPTS)).toEqual(['volatility']);
  });

  it('не влезает по марже: золото при риске 2 $ и ×5', () => {
    // Стоп 0.2% от 4000 = 8 $ → qty 0.25 · 4000 = 1000 $ номинал / 5 = 200 $ маржи.
    const r = row('XAUUSDT', {
      price: 4000,
      turnover: 150_000_000,
      m: metrics({ atrPct: 0.15, lastPrice: 4000 }),
      plan: plan({ entryMid: 4000, riskDist: 8 }),
    });
    // Золото отсеивается сразу по двум причинам: вялый ход и не влезает по марже.
    expect(suspicionsOf(r, OPTS)).toEqual(['volatility', 'size']);
  });

  it('та же золотая пара влезает при низком риске или высоком плече', () => {
    // Маржа пропорциональна риску и обратно плечу: 2 $ ×5 → 200 $ (не влезает).
    const r = row('XAUUSDT', {
      price: 4000,
      turnover: 150_000_000,
      m: metrics({ atrPct: 0.15, lastPrice: 4000 }),
      plan: plan({ entryMid: 4000, riskDist: 8 }),
    });
    // Риск 0.5 $ при ×5 → 50 $ маржи, влезает в потолок 100 $ (остаётся только вялость).
    expect(suspicionsOf(r, { riskMoney: 0.5, leverage: 5, stake: 100 })).toEqual(['volatility']);
    // Тот же риск 2 $, но плечо ×20 → 50 $ маржи, тоже влезает.
    expect(suspicionsOf(r, { riskMoney: 2, leverage: 20, stake: 100 })).toEqual(['volatility']);
  });

  it('wait-сетап проверяется только по ликвидности и волатильности', () => {
    const r = row('AAUSDT', {
      direction: 'wait',
      confidence: null,
      turnover: 1_000_000,
      m: metrics({ atrPct: 0.1 }),
      plan: plan({ direction: 'wait' }),
    });
    expect(suspicionsOf(r, OPTS)).toEqual(['liquidity', 'volatility']);
  });

  it('без метрик (свечи грузятся) ничего не режем — таблица не мигает', () => {
    const r = row('AAUSDT', { m: null, plan: null, direction: null, confidence: null, klineLoading: true });
    expect(suspicionsOf(r, OPTS)).toEqual([]);
  });
});

describe('splitSuspicious', () => {
  it('дележит выборку и сохраняет порядок нормальных пар', () => {
    const rows = [
      row('AAAUSDT'),
      row('GOLDUSDT', { plan: plan({ entryMid: 4000, riskDist: 8 }) }),
      row('BBBUSDT'),
    ];
    const { kept, hidden } = splitSuspicious(rows, OPTS);
    expect(kept.map((r) => r.symbol)).toEqual(['AAAUSDT', 'BBBUSDT']);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].row.symbol).toBe('GOLDUSDT');
    expect(hidden[0].reasons).toEqual(['size']);
  });

  it('одна пара может отсеяться по нескольким причинам', () => {
    const rows = [row('JUNKUSDT', { turnover: 1_000_000, m: metrics({ atrPct: 0.05 }) })];
    const { kept, hidden } = splitSuspicious(rows, OPTS);
    expect(kept).toEqual([]);
    expect(hidden[0].reasons).toEqual(['liquidity', 'volatility']);
  });

  it('пустая выборка — пустой результат', () => {
    expect(splitSuspicious([], OPTS)).toEqual({ kept: [], hidden: [] });
  });
});

describe('hiddenReasonsCount', () => {
  it('считает причины с пересечениями', () => {
    const rows = [
      row('AAAUSDT', { turnover: 1_000_000 }),
      row('BBBUSDT', { m: metrics({ atrPct: 0.05 }) }),
      row('CCCUSDT', { turnover: 1_000_000, m: metrics({ atrPct: 0.05 }) }),
      row('DDDUSDT', { plan: plan({ entryMid: 4000, riskDist: 8 }) }),
    ];
    const { hidden } = splitSuspicious(rows, OPTS);
    expect(hiddenReasonsCount(hidden)).toEqual({ liquidity: 2, volatility: 2, size: 1 });
  });
});
