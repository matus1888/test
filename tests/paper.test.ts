import { describe, expect, it } from 'vitest';
import {
  applySettle,
  bookedPnl,
  canOpenPosition,
  evaluatePosition,
  eventLabel,
  feeOf,
  fmtDuration,
  fmtTime,
  legsOf,
  liquidationPrice,
  pnlOf,
  remainingFrac,
  settleOpen,
  totalPnlOf,
  TP_FRACS,
  uid,
  TAKER_FEE_RATE,
  type PaperPosition,
} from '../src/lib/paper';
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

  it('лимит открытых позиций: пятая разрешена, шестая запрещена', () => {
    const four = Array.from({ length: 4 }, (_, i) => pos({ id: `p${i}`, symbol: `S${i}USDT` }));
    expect(canOpenPosition(four, draft, NOW)).toBeNull();
    const five = [...four, pos({ id: 'p4', symbol: 'S4USDT' })];
    expect(canOpenPosition(five, draft, NOW)).toMatch(/лимит/i);
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