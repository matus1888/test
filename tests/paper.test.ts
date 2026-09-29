import { describe, expect, it } from 'vitest';
import {
  applyCancel,
  applyFill,
  applySettle,
  bookedPnl,
  canOpenPosition,
  closeAllPositions,
  closeLabel,
  entryBlockReason,
  entryPriceFor,
  evaluatePosition,
  eventLabel,
  feeOf,
  fillTimeOf,
  fillsFor,
  filledAtOf,
  fmtDuration,
  fmtTime,
  isFilled,
  legsOf,
  limitGap,
  liquidationPrice,
  limitReached,
  liqToStopRatio,
  makePaperPosition,
  maxSafeLeverage,
  pendingMargin,
  positionMetrics,
  riskDistFor,
  pnlOf,
  remainingFrac,
  settleOpen,
  staleLimits,
  totalEngagedMargin,
  totalPnlOf,
  TP_FRACS,
  uid,
  TAKER_FEE_RATE,
  type PaperPosition,
} from '../src/lib/paper';
import type { TradePlan } from '../src/lib/tradePlan';
import { candle } from './helpers/candles';

const T = 60_000;

const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: 'p1',
  symbol: 'BTCUSDT',
  category: 'linear',
  interval: '5',
  direction: 'long',
  entryPrice: 100,
  stake: 100,
  leverage: 2,
  qty: 2,
  stop: 90,
  tp1: 110,
  tp2: 120,
  tp3: 130,
  entryLow: 98,
  entryHigh: 102,
  confidence: 70,
  openedAt: 0,
  status: 'open',
  ...over,
});

describe('evaluatePosition: лонг', () => {
  const candles = [
    candle(0, 105, { high: 106, low: 102 }),
    candle(1, 112, { high: 112, low: 108 }),
    candle(2, 122, { high: 122, low: 118 }),
    candle(3, 132, { high: 132, low: 128 }),
  ];

  it('последовательное достижение TP1/TP2/TP3, без стопа', () => {
    const ev = evaluatePosition(pos(), candles);
    expect(ev.stopHit).toBe(false);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1', 'tp2', 'tp3']);
    expect(ev.maxTp).toBe(3);
    expect(ev.mfeR).toBeCloseTo((132 - 100) / 10, 5);
    // MAE по построению ≥ 0 (инициализация нулём): просадок ниже входа не было.
    expect(ev.maeR).toBe(0);
  });

  it('стоп срабатывает и обрывает оценку', () => {
    const ev = evaluatePosition(pos(), [candle(0, 92, { high: 95, low: 88 })]);
    expect(ev.stopHit).toBe(true);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
    expect(ev.maxTp).toBe(0);
    expect(ev.maeR).toBeCloseTo((100 - 88) / 10, 5);
  });

  it('стоп и тейк в одной свече: стоп считается раньше (документировано)', () => {
    const ev = evaluatePosition(pos(), [candle(0, 100, { high: 115, low: 88 })]);
    expect(ev.stopHit).toBe(true);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
    expect(ev.maxTp).toBe(0);
  });

  it('частичный TP1 без TP2: maxTp=1, стопа нет', () => {
    const ev = evaluatePosition(pos(), [candle(0, 112, { high: 113, low: 108 })]);
    expect(ev.maxTp).toBe(1);
    expect(ev.stopHit).toBe(false);
  });
});

describe('evaluatePosition: шорт (зеркально)', () => {
  const short = pos({ direction: 'short', entryPrice: 100, stop: 110, tp1: 90, tp2: 80, tp3: 70 });

  it('движение против шорта (вверх) → стоп', () => {
    const ev = evaluatePosition(short, [candle(0, 108, { high: 115, low: 105 })]);
    expect(ev.stopHit).toBe(true);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
  });

  it('движение в пользу шорта → TP3, mfe в единицах риска', () => {
    const ev = evaluatePosition(short, [
      candle(0, 92, { high: 96, low: 90 }),
      candle(1, 82, { high: 86, low: 80 }),
      candle(2, 72, { high: 76, low: 70 }),
    ]);
    expect(ev.stopHit).toBe(false);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1', 'tp2', 'tp3']);
    expect(ev.maxTp).toBe(3);
    expect(ev.mfeR).toBeCloseTo((100 - 70) / 10, 5);
  });
});

describe('evaluatePosition: границы и статус', () => {
  it('закрытая позиция уважает closedAt: свечи после закрытия не считаются', () => {
    const closed = pos({ status: 'closed', closeReason: 'manual', closePrice: 105, closedAt: T });
    const ev = evaluatePosition(closed, [
      candle(0, 105, { high: 106, low: 104 }),
      candle(1, 112, { high: 112, low: 108 }), // tp1 на t=1 — до closedAt, учтён
      candle(2, 100, { high: 101, low: 88 }), // стоп-свеча ПОСЛЕ closedAt (t=2 > T), исключена
    ]);
    expect(ev.stopHit).toBe(false);
    expect(ev.maxTp).toBe(1);
  });

  it('свечи раньше openedAt не учитываются', () => {
    const ev = evaluatePosition(pos({ openedAt: 2 * T }), [
      candle(0, 80, { high: 85, low: 75 }), // до входа — стоп-свеча
      candle(2, 112, { high: 113, low: 108 }),
    ]);
    expect(ev.stopHit).toBe(false);
    expect(ev.maxTp).toBe(1);
  });

  it('partial=true, если история короче жизни позиции', () => {
    const ev = evaluatePosition(pos({ openedAt: 5 * T }), [candle(6, 105, { high: 106, low: 104 })]);
    expect(ev.partial).toBe(true);
    expect(ev.firstCandle).toBe(6 * T);
  });

  it('partial=false при полной истории', () => {
    const ev = evaluatePosition(pos(), [candle(0, 105, { high: 106, low: 104 })]);
    expect(ev.partial).toBe(false);
  });

  it('пустые свечи: без событий, без стопа', () => {
    const ev = evaluatePosition(pos(), []);
    expect(ev.stopHit).toBe(false);
    expect(ev.events).toEqual([]);
    expect(ev.maxTp).toBe(0);
  });
});

describe('settleOpen', () => {
  it('стоп → причина stop', () => {
    const s = settleOpen(pos(), [candle(0, 92, { high: 95, low: 88 })]);
    expect(s).toEqual({ closeReason: 'stop', closePrice: pos().stop, closedAt: candle(0, 92).time, legs: [] });
  });

  it('TP3 → причина tp3, ноги TP1/TP2 приложены', () => {
    const s = settleOpen(pos(), [candle(1, 132, { high: 133, low: 128 })]);
    expect(s).toEqual({
      closeReason: 'tp3',
      closePrice: 130,
      closedAt: T,
      legs: [
        { reason: 'tp1', price: 110, frac: 0.7, time: T },
        { reason: 'tp2', price: 120, frac: 0.2, time: T },
      ],
    });
  });

  it('касание TP1 без стопа/TP3 → только ноги, позиция остаётся открытой', () => {
    const s = settleOpen(pos(), [candle(1, 112, { high: 113, low: 108 })]);
    expect(s).toEqual({
      legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: T }],
    });
  });

  it('уже записанные ноги не дублируются', () => {
    const withLeg = pos({ legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: T }] });
    const s = settleOpen(withLeg, [
      candle(1, 112, { high: 113, low: 108 }),
      candle(2, 122, { high: 123, low: 118 }),
    ]);
    expect(s?.legs).toEqual([{ reason: 'tp2', price: 120, frac: 0.2, time: 2 * T }]);
    expect(s?.closeReason).toBeUndefined();
  });

  it('закрытая позиция → null', () => {
    expect(settleOpen(pos({ status: 'closed' }), [candle(0, 92, { high: 95, low: 88 })])).toBeNull();
  });

  it('нет свечей / undefined → null', () => {
    expect(settleOpen(pos(), [])).toBeNull();
    expect(settleOpen(pos(), undefined)).toBeNull();
  });
});

describe('pnlOf', () => {
  it('лонг: выход по стопу = −1R, по TP3 = +3R', () => {
    const stop = pnlOf(pos(), 90);
    expect(stop.pnl).toBeCloseTo(-20, 6);
    expect(stop.r).toBeCloseTo(-1, 6);
    expect(stop.pct).toBeCloseTo(-20, 6);

    const tp3 = pnlOf(pos(), 130);
    expect(tp3.pnl).toBeCloseTo(60, 6);
    expect(tp3.r).toBeCloseTo(3, 6);
    expect(tp3.pct).toBeCloseTo(60, 6);
  });

  it('шорт: вход 100, выход 90 → +1R', () => {
    const short = pos({ direction: 'short', entryPrice: 100, stop: 110, tp1: 90, tp2: 80, tp3: 70 });
    const r = pnlOf(short, 90);
    expect(r.pnl).toBeCloseTo(20, 6);
    expect(r.r).toBeCloseTo(1, 6);
  });

  it('entry == stop → риск-клэмп, r конечен', () => {
    const degenerate = pos({ stop: 100 });
    const r = pnlOf(degenerate, 105);
    expect(Number.isFinite(r.r)).toBe(true);
  });

  it('stake=0 → pct=0', () => {
    const r = pnlOf(pos({ stake: 0 }), 110);
    expect(r.pct).toBe(0);
  });
});

describe('liquidationPrice: изолированная маржа', () => {
  it('лонг 10×, entry 100, MMR 0,5% → 100·0,9/0,995', () => {
    const liq = liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 10 });
    expect(liq).toBeCloseTo((100 * 0.9) / 0.995, 8);
    expect(liq!).toBeLessThan(100);
  });

  it('шорт 10×, entry 100, MMR 0,5% → 100·1,1/1,005', () => {
    const liq = liquidationPrice({ direction: 'short', entryPrice: 100, leverage: 10 });
    expect(liq).toBeCloseTo((100 * 1.1) / 1.005, 8);
    expect(liq!).toBeGreaterThan(100);
  });

  it('MMR сдвигает ликвидацию к цене входа', () => {
    const noMmr = liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 10 }, 0)!;
    const withMmr = liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 10 }, 0.005)!;
    expect(noMmr).toBeCloseTo(90, 10);
    expect(withMmr).toBeGreaterThan(noMmr);
  });

  it('плечо 1× лонг → 0 (ликвидация недостижима)', () => {
    expect(liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 1 })).toBe(0);
  });

  it('плечо 1× шорт → ≈2× входа', () => {
    expect(liquidationPrice({ direction: 'short', entryPrice: 100, leverage: 1 })).toBeCloseTo(200 / 1.005, 8);
  });

  it('невалидные входы → null', () => {
    expect(liquidationPrice({ direction: 'long', entryPrice: 0, leverage: 10 })).toBeNull();
    expect(liquidationPrice({ direction: 'long', entryPrice: -5, leverage: 10 })).toBeNull();
    expect(liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 0 })).toBeNull();
    expect(liquidationPrice({ direction: 'long', entryPrice: NaN, leverage: 10 })).toBeNull();
    expect(liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 10 }, 1)).toBeNull();
    expect(liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 10 }, -0.1)).toBeNull();
  });
});

describe('feeOf и чистый P&L', () => {
  it('ставки тейкера по категориям', () => {
    expect(TAKER_FEE_RATE).toMatchObject({ spot: 0.001, linear: 0.00055, inverse: 0.00055, option: 0.0003 });
  });

  it('комиссия за круг: 2 × номинал × ставка (linear: 2·200·0,00055 = 0,22)', () => {
    expect(feeOf(pos())).toBeCloseTo(0.22, 10);
  });

  it('спот дороже фьючерсов', () => {
    expect(feeOf(pos({ category: 'spot' }))).toBeCloseTo(2 * 200 * 0.001, 10);
  });

  it('нулевой номинал → комиссия 0', () => {
    expect(feeOf(pos({ qty: 0 }))).toBe(0);
  });

  it('net = pnl − fee; netPct и netR согласованы', () => {
    const r = pnlOf(pos(), 130);
    expect(r.fee).toBeCloseTo(0.22, 10);
    expect(r.net).toBeCloseTo(60 - 0.22, 8);
    expect(r.netPct).toBeCloseTo(((60 - 0.22) / 100) * 100, 8);
    expect(r.netR).toBeCloseTo((60 - 0.22) / 20, 8);
  });

  it('убыточная сделка: комиссия углубляет минус', () => {
    const r = pnlOf(pos(), 95);
    expect(r.pnl).toBeCloseTo(-10, 8);
    expect(r.net).toBeCloseTo(-10.22, 8);
  });
});

describe('evaluatePosition: безубыток после TP1', () => {
  it('TP1 затем возврат к цене входа → breakeven, стопа нет', () => {
    const ev = evaluatePosition(pos(), [
      candle(0, 105, { high: 106, low: 104 }),
      candle(1, 112, { high: 112, low: 108 }),
      candle(2, 99, { high: 105, low: 99 }),
    ]);
    expect(ev.stopHit).toBe(false);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1', 'breakeven']);
    expect(ev.events[1]).toMatchObject({ price: 100, time: 2 * T });
    expect(ev.maxTp).toBe(1);
  });

  it('TP1 затем TP3 → безубытка нет, обычный проход', () => {
    const ev = evaluatePosition(pos(), [
      candle(0, 112, { high: 113, low: 108 }),
      candle(1, 132, { high: 133, low: 125 }),
    ]);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1', 'tp2', 'tp3']);
    expect(ev.stopHit).toBe(false);
  });

  it('стоп и TP1 в одной свече: стоп раньше (приоритет сохранён)', () => {
    const ev = evaluatePosition(pos(), [candle(0, 100, { high: 115, low: 88 })]);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
    expect(ev.stopHit).toBe(true);
  });

  it('TP1 и касание входа в одной свече (стоп не задет): только TP1, без безубытка в той же свече', () => {
    const ev = evaluatePosition(pos(), [candle(0, 105, { high: 112, low: 95 })]);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1']);
    expect(ev.stopHit).toBe(false);
  });

  it('шорт зеркально: TP1 затем возврат к входу → breakeven', () => {
    const short = pos({ direction: 'short', entryPrice: 100, stop: 110, tp1: 90, tp2: 80, tp3: 70 });
    const ev = evaluatePosition(short, [
      candle(0, 92, { high: 96, low: 88 }),
      candle(1, 101, { high: 102, low: 99 }),
    ]);
    expect(ev.stopHit).toBe(false);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1', 'breakeven']);
  });

  it('settleOpen закрывает по безубытку по цене входа', () => {
    const s = settleOpen(pos(), [
      candle(0, 112, { high: 113, low: 108 }),
      candle(1, 99, { high: 105, low: 99 }),
    ]);
    expect(s).toEqual({
      closeReason: 'breakeven',
      closePrice: 100,
      closedAt: T,
      legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }],
    });
  });

  it('безубыток даёт P&L ≈ −комиссия', () => {
    const r = pnlOf(pos(), 100);
    expect(r.pnl).toBe(0);
    expect(r.net).toBeCloseTo(-r.fee, 10);
  });
});

describe('canOpenPosition: дубли и лимиты', () => {
  const NOW = 1_800_000_000_000;
  const draft = { symbol: 'BTCUSDT', category: 'linear' as const, interval: '5' as const, direction: 'long' as const };

  it('пустой портфель → разрешено', () => {
    expect(canOpenPosition([], draft, NOW)).toBeNull();
  });

  it('дубль открытой позиции запрещён', () => {
    const reason = canOpenPosition([pos()], draft, NOW);
    expect(reason).toMatch(/дубль/i);
  });

  it('тот же символ в другую сторону — разрешён', () => {
    expect(canOpenPosition([pos()], { ...draft, direction: 'short' }, NOW)).toBeNull();
  });

  it('другой интервал — разрешён', () => {
    expect(canOpenPosition([pos()], { ...draft, interval: '15' }, NOW)).toBeNull();
  });

  it('лимит открытых позиций: по умолчанию нет (тестовый режим)', () => {
    const many = Array.from({ length: 12 }, (_, i) => pos({ id: `p${i}`, symbol: `S${i}USDT` }));
    expect(canOpenPosition(many, draft, NOW)).toBeNull();
  });

  it('дневной убыток ниже лимита блокирует входы', () => {
    // Каждый стоп: (90−100)×2 = −20, net −20.22. Восемь стопов за час → −161.76 < −150.
    const losers = Array.from({ length: 8 }, (_, i) =>
      pos({ id: `l${i}`, symbol: `L${i}`, status: 'closed', closeReason: 'stop', closePrice: 90, closedAt: NOW - 3600_000 }),
    );
    expect(canOpenPosition(losers, draft, NOW)).toMatch(/дневной лимит/i);
    // Семь стопов (−141.54) — ещё можно.
    expect(canOpenPosition(losers.slice(0, 7), draft, NOW)).toBeNull();
  });

  it('старые убытки (старше 24ч) не считаются', () => {
    const old = Array.from({ length: 8 }, (_, i) =>
      pos({ id: `l${i}`, symbol: `L${i}`, status: 'closed', closeReason: 'stop', closePrice: 90, closedAt: NOW - 25 * 3600_000 }),
    );
    expect(canOpenPosition(old, draft, NOW)).toBeNull();
  });

  it('прибыли дня компенсируют убытки', () => {
    const winner = pos({ id: 'w', symbol: 'W', status: 'closed', closeReason: 'tp3', closePrice: 130, closedAt: NOW - 3600_000 });
    const loser = pos({ id: 'l', symbol: 'L', status: 'closed', closeReason: 'stop', closePrice: 90, closedAt: NOW - 3600_000 });
    // +59.78 − 20.22 = +39.56 за день → разрешено.
    expect(canOpenPosition([winner, loser], draft, NOW)).toBeNull();
  });

  it('лимиты параметризуются', () => {
    const other = pos({ symbol: 'ETHUSDT' });
    expect(canOpenPosition([other], draft, NOW, { maxOpen: 1, maxDailyLoss: 150 })).toMatch(/лимит/i);
  });
});

describe('eventLabel', () => {
  it('подписи событий', () => {
    expect(eventLabel('tp1')).toBe('TP1');
    expect(eventLabel('tp2')).toBe('TP2');
    expect(eventLabel('tp3')).toBe('TP3');
    expect(eventLabel('stop')).toBe('Стоп');
    expect(eventLabel('breakeven')).toBe('Б/У');
    expect(eventLabel('liq')).toBe('LIQ');
  });
});

describe('ликвидация и её запас относительно стопа', () => {
  it('liqToStopRatio: безопасное плечо даёт запас > 1', () => {
    // entry 100, stop 90, lev 2 → liq=50.25..., запас = (100-liq)/10
    const liq = liquidationPrice({ direction: 'long', entryPrice: 100, leverage: 2 });
    expect(liq).not.toBeNull();
    expect(liqToStopRatio(100, 90, 'long', 2)).toBeCloseTo((100 - liq!) / 10, 10);
    expect(liqToStopRatio(100, 90, 'long', 2)!).toBeGreaterThan(1);
  });

  it('liqToStopRatio: высокое плечо ставит ликвидацию ближе стопа (< 1)', () => {
    // lev 25 → liq = 100·(24/25)/0.995 ≈ 96.48, запас = 3.52/10 ≈ 0.35
    const ratio = liqToStopRatio(100, 90, 'long', 25);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeLessThan(1);
  });

  it('maxSafeLeverage: широкий стоп NILUSDT 8,1% допускает ~8,4x', () => {
    const entry = 0.1364199299237837;
    const stop = 0.12537800270471025;
    const maxLev = maxSafeLeverage(entry, stop, 'long');
    expect(maxLev).not.toBeNull();
    // при ×3 запас большой, при ×10 уже недостаточный
    expect(liqToStopRatio(entry, stop, 'long', 3)!).toBeGreaterThan(1.5);
    expect(liqToStopRatio(entry, stop, 'long', 10)!).toBeLessThan(1.43);
    expect(maxLev!).toBeGreaterThan(3);
    expect(maxLev!).toBeLessThan(10);
  });

  it('евент/движок: ликвидация раньше стопа при опасном плече', () => {
    const unsafe = pos({ leverage: 25 }); // liq ≈ 96.48 > стоп 90 → ликвидация ближе
    const ev = evaluatePosition(unsafe, [candle(0, 95, { high: 96.5, low: 94 })]);
    expect(ev.liqHit).toBe(true);
    expect(ev.events.map((e) => e.type)).toEqual(['liq']);
    const s = settleOpen(unsafe, [candle(0, 95, { high: 96.5, low: 94 })]);
    expect(s?.closeReason).toBe('liq');
  });

  it('евент/движок: безопасная позиция закрывается стопом, не ликвидацией', () => {
    const safe = pos(); // lev 2, liq 50.25 — далеко
    const ev = evaluatePosition(safe, [candle(0, 92, { high: 95, low: 88 })]);
    expect(ev.stopHit).toBe(true);
    expect(ev.liqHit).toBe(false);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
    expect(settleOpen(safe, [candle(0, 92, { high: 95, low: 88 })])?.closeReason).toBe('stop');
  });

  it('closeLabel: ликвидация', () => {
    expect(closeLabel('liq')).toBe('Ликвидация');
    expect(closeLabel('stop')).toBe('Стоп');
  });
});

describe('частичный выход 70/20/10', () => {
  it('доли лесенки суммируются с раннером в единицу', () => {
    expect(TP_FRACS.tp1 + TP_FRACS.tp2).toBeLessThan(1);
    expect(TP_FRACS.tp1).toBe(0.7);
    expect(TP_FRACS.tp2).toBe(0.2);
  });

  it('legsOf извлекает ноги TP1/TP2 из событий', () => {
    const ev = evaluatePosition(pos(), [
      candle(0, 112, { high: 113, low: 108 }),
      candle(1, 122, { high: 123, low: 118 }),
    ]);
    expect(legsOf(ev)).toEqual([
      { reason: 'tp1', price: 110, frac: 0.7, time: 0 },
      { reason: 'tp2', price: 120, frac: 0.2, time: T },
    ]);
  });

  it('remainingFrac: 1 без ног, 0.3 после TP1, 0.1 после TP1+TP2', () => {
    expect(remainingFrac(pos())).toBe(1);
    expect(remainingFrac(pos({ legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }] }))).toBeCloseTo(0.3, 10);
    expect(remainingFrac(pos({
      legs: [
        { reason: 'tp1', price: 110, frac: 0.7, time: 0 },
        { reason: 'tp2', price: 120, frac: 0.2, time: T },
      ],
    }))).toBeCloseTo(0.1, 10);
  });

  it('bookedPnl: 70% по TP1 лонга = 0.7 × 10 × 2', () => {
    const p = pos({ legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }] });
    expect(bookedPnl(p)).toBeCloseTo(0.7 * 2 * (110 - 100), 8);
  });

  it('bookedPnl зеркален для шорта', () => {
    const short = pos({
      direction: 'short', entryPrice: 100, stop: 110, tp1: 90, tp2: 80, tp3: 70,
      legs: [{ reason: 'tp1', price: 90, frac: 0.7, time: 0 }],
    });
    expect(bookedPnl(short)).toBeCloseTo(0.7 * 2 * (100 - 90), 8);
  });

  it('totalPnlOf без ног совпадает с pnlOf по гроссу', () => {
    const a = pnlOf(pos(), 130);
    const b = totalPnlOf(pos(), 130);
    expect(b.pnl).toBeCloseTo(a.pnl, 10);
    expect(b.net).toBeCloseTo(a.net, 10);
    expect(b.booked).toBe(0);
    expect(b.remaining).toBe(1);
  });

  it('totalPnlOf с ногой TP1: booked + переоценка остатка 30%', () => {
    const p = pos({ legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }] });
    const b = totalPnlOf(p, 120);
    // booked 0.7×20=14, остаток 0.3: (120−100)×2×0.3=12 → гросс 26
    expect(b.booked).toBeCloseTo(14, 8);
    expect(b.pnl).toBeCloseTo(26, 8);
    expect(b.remaining).toBeCloseTo(0.3, 10);
    expect(b.fee).toBeCloseTo(feeOf(pos()), 10); // комиссия — полный круг
  });

  it('applySettle: сливает ноги без закрытия', () => {
    const next = applySettle([pos()], [{ id: 'p1', info: { legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }] } }]);
    expect(next[0].status).toBe('open');
    expect(next[0].legs).toHaveLength(1);
  });

  it('applySettle: закрытие сохраняет ноги', () => {
    const withLeg = pos({ legs: [{ reason: 'tp1', price: 110, frac: 0.7, time: 0 }] });
    const next = applySettle([withLeg], [{
      id: 'p1',
      info: { closeReason: 'stop', closePrice: 90, closedAt: 5 * T, legs: [] },
    }]);
    expect(next[0].status).toBe('closed');
    expect(next[0].closeReason).toBe('stop');
    expect(next[0].legs).toHaveLength(1);
  });

  it('applySettle: без изменений возвращает тот же массив', () => {
    const prev = [pos()];
    expect(applySettle(prev, [])).toBe(prev);
    expect(applySettle(prev, [{ id: 'zzz', info: { legs: [] } }])).toBe(prev);
  });
});

describe('вспомогательные функции', () => {
  it('positionMetrics: маржа = номинал/плечо', () => {
    expect(positionMetrics(pos())).toEqual({ notional: 200, margin: 100 }); // ×2
    expect(positionMetrics(pos({ leverage: 20 }))).toEqual({ notional: 200, margin: 10 });
    expect(positionMetrics(pos({ leverage: 0 }))).toEqual({ notional: 200, margin: 200 }); // no-lev fallback
  });

  it('P&L в $ НЕ зависит от плеча; % к марже усиливается плечом', () => {
    const base = pos();          // qty 2, entry 100, lev 2 → маржа 100
    const lev20 = pos({ leverage: 20 }); // маржа 10
    expect(pnlOf(base, 130).pnl).toBe(pnlOf(lev20, 130).pnl);        // 60 $
    expect(pnlOf(lev20, 130).pnl).toBe(60);
    expect(pnlOf(lev20, 130).pctMargin).toBeCloseTo(pnlOf(base, 130).pctMargin * 10, 6);
    expect(pnlOf(lev20, 130).pct).toBeCloseTo(pnlOf(base, 130).pct, 10); // % к ставке не меняется
    expect(totalPnlOf(base, 130).netR).toBeCloseTo(totalPnlOf(lev20, 130).netR, 8);
  });

  it('маржинальные метрики в totalPnlOf и pnlOf согласованы', () => {
    const r = totalPnlOf(pos(), 130);
    expect(r.notional).toBe(200);
    expect(r.margin).toBe(100);
    expect(r.pctMargin).toBeCloseTo((60 / 100) * 100, 8);
    expect(r.netMarginPct).toBeCloseTo(((60 - r.fee) / 100) * 100, 8);
  });

  it('fmtDuration', () => {
    expect(fmtDuration(30 * 60_000)).toBe('30 мин');
    expect(fmtDuration(90 * 60_000)).toBe('1 ч 30 мин');
    expect(fmtDuration(3000 * 60_000)).toBe('2 дн 2 ч');
  });

  it('fmtTime возвращает время с минутами', () => {
    expect(/\d{2}:\d{2}/.test(fmtTime(0))).toBe(true);
  });

  it('uid уникален и непустой', () => {
    expect(uid()).not.toBe(uid());
    expect(uid().length).toBeGreaterThan(0);
  });
});

describe('entryBlockReason / makePaperPosition (быстрый вход из таблиц)', () => {
  const plan = (over: Partial<TradePlan> = {}): TradePlan => ({
    direction: 'long',
    confidence: 85,
    regime: '',
    horizon: '',
    price: 100,
    atr: 1,
    ema20: 101,
    ema50: 100.5,
    recentHigh: 105,
    recentLow: 95,
    entryLow: 99.5,
    entryHigh: 100.5,
    entryMid: 100,
    stop: 91,
    tp1: 110,
    tp2: 120,
    tp3: 130,
    riskDist: 9,
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
  const draft = { symbol: 'AAAUSDT', category: 'linear' as const, interval: '5' as const, direction: 'long' as const };
  const opts = { deposit: 1000, riskPct: 1, stake: 250, leverage: 3 };

  it('makePaperPosition: размер из риска (riskMoney/riskDist), поля из плана, статус — заявка', () => {
    const p = makePaperPosition('AAAUSDT', 'linear', '5', plan(), opts);
    expect(p.qty).toBeCloseTo(10 / 9, 8);
    expect(p.entryPrice).toBe(100);
    expect(p.riskMoney).toBe(10);
    expect(p.stop).toBe(91);
    expect(p.direction).toBe('long');
    // Позиции ещё нет: выставлен лимит, ждём касания цены.
    expect(p.status).toBe('pending');
    expect(p.filledAt).toBeUndefined();
  });

  it('makePaperPosition по рынку: цена = текущая котировка, позиция открыта сразу', () => {
    // Цена выше середины зоны (лонг ждал отката) — вход по рынку исполняется тут же.
    const p = makePaperPosition('AAAUSDT', 'linear', '5', plan({ price: 103 }), opts, { kind: 'market', price: 103 });
    expect(p.entryPrice).toBe(103);
    expect(p.entryKind).toBe('market');
    expect(p.status).toBe('open');
    expect(p.filledAt).toBe(p.openedAt);
    expect(filledAtOf(p)).toBe(p.openedAt);
    // Размер — от фактической дистанции до стопа (|103−91| = 12, а не плановые 9):
    // риск в $ тот же, но количество меньше.
    expect(p.qty).toBeCloseTo(10 / 12, 8);
    expect(Math.abs(p.entryPrice - p.stop) * p.qty).toBeCloseTo(10, 8);
    // Плата за вход без отката: дистанция до стопа шире, поэтому при том же риске
    // количество меньше и маржа ниже — но и до TP1 дальше, то есть RR хуже.
    const limitPos = makePaperPosition('AAAUSDT', 'linear', '5', plan({ price: 103 }), opts);
    expect(positionMetrics(p).margin).toBeLessThan(positionMetrics(limitPos).margin);
    // ...но до TP1 в R получается хуже: риск до стопа вырос, а цель та же
    const rrTp1 = (x: PaperPosition) => Math.abs(x.tp1 - x.entryPrice) / Math.abs(x.entryPrice - x.stop);
    expect(rrTp1(limitPos)).toBeCloseTo(10 / 9, 8);
    expect(rrTp1(p)).toBeCloseTo(7 / 12, 8);
    expect(rrTp1(p)).toBeLessThan(rrTp1(limitPos));
    // Плановая дистанция риска из плана при этом не изменилась — риск в $ один и тот же.
    expect(plan({ price: 103 }).riskDist).toBe(9);
  });

  it('entryPriceFor / riskDistFor: рынок — котировка, лимит — середина зоны', () => {
    expect(entryPriceFor('limit', plan(), 103)).toBe(100);
    expect(entryPriceFor('market', plan(), 103)).toBe(103);
    // без котировки рыночный вход невозможен — падаем обратно на лимит
    expect(entryPriceFor('market', plan(), null)).toBe(100);
    expect(entryPriceFor('market', plan(), 0)).toBe(100);
    expect(riskDistFor(103, plan())).toBe(12);
    expect(riskDistFor(100, plan())).toBe(9);
    expect(riskDistFor(93, plan())).toBe(2);
  });

  it('entryBlockReason по рынку: те же ворота, плюс требование котировки', () => {
    expect(entryBlockReason([], draft, plan(), opts, { kind: 'market', price: 103 })).toBeNull();
    // без цены вход по рынку невозможен
    expect(entryBlockReason([], draft, plan(), opts, { kind: 'market' })).toMatch(/текущей цены/i);
    expect(entryBlockReason([], draft, plan(), opts, { kind: 'market', price: 0 })).toMatch(/текущей цены/i);
    // дубль блокирует и рыночный вход
    expect(entryBlockReason([pos({ symbol: 'AAAUSDT' })], draft, plan(), opts, { kind: 'market', price: 103 })).toMatch(/дубль/i);
    // риск/ликвидация/маржа считаются от фактической цены входа: чем ближе вход к стопу,
    // тем крупнее позиция под тот же риск и тем больше маржа.
    const tightStake = { ...opts, stake: 40 };
    expect(entryBlockReason([], draft, plan(), tightStake)).toBeNull();          // маржа 37 $ — помещается
    expect(entryBlockReason([], draft, plan(), { ...opts, stake: 20 })).toMatch(/маржи/i);
    // цена упала к стопу (95 против стопа 91): та же ставка уже не помещается
    expect(
      entryBlockReason([], draft, plan({ price: 95 }), tightStake, { kind: 'market', price: 95 }),
    ).toMatch(/маржи/i);
  });

  it('рыночный вход: лесенка и стоп работают как у лимитного, бар входа — только по вредной стороне', () => {
    const p = makePaperPosition('AAAUSDT', 'linear', '5', plan({ price: 103 }), opts, { kind: 'market', price: 103 });
    // Вход по рынку происходит «сейчас»: свечи раньше filledAt движка не касаются,
    // а бар самого входа оценивается только по вредной стороне (его максимум был до входа).
    const bar = { high: 112, low: 100 };
    expect(evaluatePosition(p, [candle(0, 103, { ...bar, time: 1_000_000 })]).events).toEqual([]);
    const filled = { ...p, openedAt: 1_000, filledAt: 1_000 };
    // бар самого входа: максимум мог быть ДО входа, поэтому TP1 здесь не засчитывается
    expect(evaluatePosition(filled, [candle(0, 103, { ...bar, time: 1_000 })]).events).toEqual([]);
    const ev = evaluatePosition(filled, [
      candle(0, 103, { ...bar, time: 1_000 }),
      candle(1, 109, { ...bar, time: 2_000 }),
    ]);
    expect(ev.events.map((e) => e.type)).toContain('tp1');
    expect(ev.maxTp).toBe(1);
  });

  it('entryBlockReason: разрешён → null', () => {
    expect(entryBlockReason([], draft, plan(), opts)).toBeNull();
  });

  it('entryBlockReason: без направленного сетапа → причина', () => {
    const w = plan({ direction: 'wait' });
    expect(entryBlockReason([], draft, w, opts)).toMatch(/нет направленного/i);
  });

  it('entryBlockReason: маржа больше ставки → блок', () => {
    const big = { ...opts, riskPct: 40, stake: 100 }; // риск 400, qty 44.4, маржа 1481 > 100
    expect(entryBlockReason([], draft, plan(), big)).toMatch(/маржи/i);
  });

  it('entryBlockReason: ликвидация ближе стопа при большом плече → блок', () => {
    // стоп 91 от entry 100: при ×20 liq 95.48 — ближе стопа
    expect(entryBlockReason([], draft, plan(), { ...opts, leverage: 20 })).toMatch(/ликвидаци/i);
    // при ×3 безопасно
    expect(entryBlockReason([], draft, plan(), opts)).toBeNull();
  });

  it('entryBlockReason: дубль блокирует', () => {
    expect(entryBlockReason([pos({ symbol: 'AAAUSDT' })], draft, plan(), opts)).toMatch(/дубль/i);
  });

  it('entryBlockReason: висящая заявка в рынке — тоже дубль', () => {
    const pending = pos({ symbol: 'AAAUSDT', status: 'pending' });
    expect(entryBlockReason([pending], draft, plan(), opts)).toMatch(/дубль/i);
    // отменённая заявка дублем не считается
    const cancelled = pos({ symbol: 'AAAUSDT', status: 'cancelled' });
    expect(entryBlockReason([cancelled], draft, plan(), opts)).toBeNull();
  });

  it('портфельный лимит не считает неисполненные заявки', () => {
    const pending = Array.from({ length: 5 }, (_, i) => pos({ id: `p${i}`, symbol: `P${i}USDT`, status: 'pending' }));
    const fiveHundred = { deposit: 500, riskPct: 1, stake: 1000, leverage: 3 };
    expect(entryBlockReason(pending, draft, plan(), fiveHundred)).toBeNull();
  });

  it('портфельный лимит: суммарная маржа открытых ≤ депозита', () => {
    const fill = Array.from({ length: 5 }, (_, i) => pos({ id: `f${i}`, symbol: `F${i}USDT` })); // маржа 5×100 = 500
    const fiveHundred = { deposit: 500, riskPct: 1, stake: 1000, leverage: 3 };
    expect(entryBlockReason(fill, draft, plan(), fiveHundred)).toMatch(/капитал/i);
    // пустой портфель — разрешено
    expect(entryBlockReason([], draft, plan(), fiveHundred)).toBeNull();
  });
});

describe('closeAllPositions', () => {
  const p = (over: Partial<Parameters<typeof pos>[0]> = {}): ReturnType<typeof pos> => pos(over);

  it('закрывает все открытые по цене функции, закрытые не трогает', () => {
    const open1 = p({ id: 'o1', symbol: 'AAAUSDT' });
    const open2 = p({ id: 'o2', symbol: 'BBBUSDT' });
    const closed = p({ id: 'c1', symbol: 'CCCUSDT', status: 'closed' as const, closePrice: 100, closedAt: 1 });
    const next = closeAllPositions([open1, open2, closed], (x) => x.entryPrice + 10, 12345);
    expect(next.filter((x) => x.status === 'open')).toHaveLength(0);
    expect(next[0]).toMatchObject({ status: 'closed', closeReason: 'manual', closePrice: open1.entryPrice + 10, closedAt: 12345 });
    expect(next[2]).toBe(closed); // закрытая не меняется
  });

  it('пустой/без открытых — без изменений или пустой список', () => {
    expect(closeAllPositions([], () => 1)).toEqual([]);
    const onlyClosed = p({ id: 'c', symbol: 'CUSDT', status: 'closed' as const });
    expect(closeAllPositions([onlyClosed], () => 1)).toEqual([onlyClosed]);
  });

  it('неисполненные заявки снимаются, а не «закрываются»', () => {
    const pending = p({ id: 'z1', symbol: 'ZZZUSDT', status: 'pending' });
    const next = closeAllPositions([pending], (x) => x.entryPrice + 10, 1);
    expect(next[0]).toMatchObject({ status: 'cancelled', cancelReason: 'manual' });
    expect(next[0].closePrice).toBeUndefined();
  });
});

describe('лимитная заявка: исполнение по касанию цены', () => {
  const limit = (over: Partial<PaperPosition> = {}): PaperPosition =>
    pos({ status: 'pending', entryPrice: 100, stop: 90, tp1: 110, openedAt: 0, ...over });

  it('filledAtOf: pending без filledAt → ещё не исполнена; legacy-позиции исполнены в openedAt', () => {
    expect(filledAtOf(limit())).toBeUndefined();
    expect(filledAtOf(pos())).toBe(0);
    expect(filledAtOf(limit({ filledAt: 7 }))).toBe(7);
    expect(isFilled(limit())).toBe(false);
    expect(isFilled(limit({ filledAt: 7 }))).toBe(true);
  });

  it('снятая заявка — тоже без сделок: filledAt пуст, P&L и комиссия нулевые', () => {
    const dead = limit({ status: 'cancelled', cancelReason: 'manual', closedAt: 5 });
    expect(filledAtOf(dead)).toBeUndefined();
    expect(isFilled(dead)).toBe(false);
    // цена где угодно — результат нулевой и без комиссии (на бирже заявку без исполнения не списывают)
    for (const price of [0, 90, 130, 1000]) {
      const r = totalPnlOf(dead, price);
      expect(r.pnl).toBe(0);
      expect(r.net).toBe(0);
      expect(r.fee).toBe(0);
      expect(r.netR).toBe(0);
    }
    expect(feeOf(dead)).toBe(0);
    // и событий движка не будет: позиции не существовало
    expect(evaluatePosition(dead, [candle(0, 130, { high: 135, low: 85 })]).events).toEqual([]);
    expect(settleOpen(dead, [candle(0, 130, { high: 135, low: 85 })])).toBeNull();
  });

  it('limitReached: лонг исполняется на касании лимита снизу, шорт — снизу вверх', () => {
    const l = limit();
    expect(limitReached(l, 101)).toBe(false);
    expect(limitReached(l, 100)).toBe(true);
    expect(limitReached(l, 98)).toBe(true);
    const s = limit({ direction: 'short', stop: 110, tp1: 90 });
    expect(limitReached(s, 99)).toBe(false);
    expect(limitReached(s, 100)).toBe(true);
    expect(limitReached(s, 103)).toBe(true);
    // мусор на входе не считается касанием
    expect(limitReached(l, Number.NaN)).toBe(false);
    expect(limitReached(l, 0)).toBe(false);
  });

  it('limitGap: сколько ещё не хватает цене до лимита (0 = лимит в рынке)', () => {
    expect(limitGap(limit(), 100)).toBe(0);
    expect(limitGap(limit(), 105)).toBeCloseTo(0.05, 8);
    const s = limit({ direction: 'short', stop: 110, tp1: 90 });
    expect(limitGap(s, 95)).toBeCloseTo(0.05, 8);
  });

  it('fillTimeOf: цена не дошла — заявка в рынке', () => {
    const l = limit();
    const candles = [candle(0, 104, { high: 106, low: 102 })]; // до лимита не дошли
    expect(fillTimeOf(l, candles, 103, 10 * T)).toBeNull();
  });

  it('fillTimeOf: по живой цене — момент «сейчас»', () => {
    expect(fillTimeOf(limit(), [], 99.5, 10 * T)).toBe(10 * T);
  });

  it('fillTimeOf: по истории свечей берётся время самой ранней (вкладка была закрыта)', () => {
    const l = limit();
    const candles = [candle(0, 104, { high: 105, low: 103 }), candle(1, 101, { high: 102, low: 98 })];
    expect(fillTimeOf(l, candles, 104, 10 * T)).toBe(T);
  });

  it('fillTimeOf: свечи до постановки заявки не считаются', () => {
    const l = limit({ openedAt: 3 * T });
    const candles = [candle(0, 95, { high: 96, low: 94 }), candle(3, 99, { high: 100, low: 98 })];
    // первая свеча была до заявки; вторая её задевает
    expect(fillTimeOf(l, candles, null, 10 * T)).toBe(3 * T);
    expect(fillTimeOf(l, [candles[0]], null, 10 * T)).toBeNull();
  });

  it('totalPnlOf по заявке строго нулевой: никакой «мгновенной прибыли»', () => {
    const l = limit();                       // лимит 100, цена 130 — максимально «выгодный» вход
    const r = totalPnlOf(l, 130);
    expect(r.pnl).toBe(0);
    expect(r.net).toBe(0);
    expect(r.r).toBe(0);
    expect(r.netR).toBe(0);
    expect(r.fee).toBe(0);
    expect(r.netMarginPct).toBe(0);
    // но размер виден: сколько встанет в работу при исполнении
    expect(r.notional).toBe(200);
    expect(r.margin).toBe(100);
  });

  it('evaluatePosition по заявке: событий нет (позиции ещё нет)', () => {
    const ev = evaluatePosition(limit(), [candle(0, 130, { high: 135, low: 85 })]);
    expect(ev.events).toEqual([]);
    expect(ev.maxTp).toBe(0);
    expect(ev.mfeR).toBe(0);
    expect(ev.stopHit).toBe(false);
  });

  it('settleOpen по заявке → null', () => {
    expect(settleOpen(limit(), [candle(0, 130, { high: 135, low: 85 })])).toBeNull();
  });

  it('fillsFor: собирает только реально исполненные заявки', () => {
    const a = limit({ id: 'a' });                              // лонг, цена 99 ≤ лимита 100 → исполнен
    const b = limit({ id: 'b', direction: 'short', stop: 110, tp1: 90 }); // шорт, цена 99 < 100 → ждём роста
    const c = limit({ id: 'c', entryPrice: 50 });                // лонг, цена 120 > 50 → ждём отката
    const price = (p: PaperPosition) => (p.id === 'a' ? 99 : 99);
    expect(fillsFor([a, b, c], () => [], price, 10 * T)).toEqual([
      { id: 'a', info: { filledAt: 10 * T } },
    ]);
    // шорт исполняется, когда цена доходит до лимита снизу вверх
    expect(fillsFor([b], () => [], () => 101, 10 * T)).toEqual([{ id: 'b', info: { filledAt: 10 * T } }]);
    expect(fillsFor([pos()], () => [], () => 1, 10 * T)).toEqual([]); // уже исполненная — нечего делать
  });

  it('staleLimits: неисполненная заявка протухает по TTL', () => {
    const day = 24 * 3600 * 1000;
    const fresh = limit({ openedAt: day });        // висит меньше суток
    const old = limit({ id: 'old', openedAt: 0 }); // висит двое суток
    expect(staleLimits([fresh], day + 1000)).toEqual([]);
    expect(staleLimits([old], day * 2)).toEqual([{ id: 'old', reason: 'stale' }]);
    expect(staleLimits([pos({ openedAt: 0 })], day * 2)).toEqual([]); // исполненные не трогаем
  });

  it('applyFill: pending → open с отметкой исполнения, без изменений — тот же массив', () => {
    const l = [limit()];
    const next = applyFill(l, [{ id: 'p1', info: { filledAt: T } }]);
    expect(next[0].status).toBe('open');
    expect(next[0].filledAt).toBe(T);
    const prev = [pos()];
    expect(applyFill(prev, [])).toBe(prev);
    expect(applyFill(prev, [{ id: 'p1', info: { filledAt: T } }])).toBe(prev);
  });

  it('applyCancel: заявка снимается с причиной и временем, исполненные не трогаем', () => {
    const next = applyCancel([limit()], [{ id: 'p1', reason: 'stale' }], 9);
    expect(next[0]).toMatchObject({ status: 'cancelled', cancelReason: 'stale', closedAt: 9 });
    const prev = [pos()];
    expect(applyCancel(prev, [{ id: 'p1', reason: 'manual' }])).toBe(prev);
  });

  it('pendingMargin: заявки не входят в занятый капитал, но видны отдельно', () => {
    const list = [limit({ id: 'a' }), limit({ id: 'b' }), pos({ id: 'c' })];
    expect(totalEngagedMargin(list)).toBe(100);   // только исполненная
    expect(pendingMargin(list)).toBe(200);        // две заявки по 100 маржи
  });

  it('бар исполнения: стоп засчитывается, тейк — нет (движение внутри бара неизвестно)', () => {
    // исполнение найдено по самой свече: её максимум мог быть ДО входа
    const filled = pos({ filledAt: 0 });
    const ev = evaluatePosition(filled, [
      candle(0, 104, { high: 115, low: 98 }), // TP1=110 задет, но до исполнения мог быть
      candle(1, 112, { high: 113, low: 108 }), // TP1 уже засчитывается
    ]);
    expect(ev.events.map((e) => e.type)).toEqual(['tp1']);
    expect(ev.events[0].time).toBe(T);
    // MFE считается по бару после исполнения (113−100)/10 = 1.3R, максимум бара
    // исполнения (115) в MFE не попадает — иначе это был бы ход ДО входа.
    expect(ev.mfeR).toBeCloseTo(1.3, 8);
  });

  it('бар исполнения: стоп внутри него честно закрывает позицию', () => {
    const filled = pos({ filledAt: 0 });
    const ev = evaluatePosition(filled, [candle(0, 100, { high: 102, low: 85 })]);
    expect(ev.stopHit).toBe(true);
    expect(ev.events.map((e) => e.type)).toEqual(['stop']);
  });

  it('без filledAt (legacy/запись до появления лимитов) бар исполнения не выделяется', () => {
    const ev = evaluatePosition(pos(), [candle(0, 112, { high: 113, low: 108 })]);
    expect(ev.maxTp).toBe(1);
    expect(ev.mfeR).toBeCloseTo(1.3, 8);
  });
});