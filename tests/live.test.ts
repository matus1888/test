import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReal, planLadder, roundDownToStep, roundToTick, type InstrumentInfo } from '../src/api/live';
import type { TradePlan } from '../src/lib/tradePlan';

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
  stop: 90,
  tp1: 110,
  tp2: 120,
  tp3: 130,
  riskDist: 10,
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

const okResult = (result: unknown) => ({
  ok: true,
  text: async () => JSON.stringify({ retCode: 0, retMsg: 'OK', result }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('округление', () => {
  it('roundDownToStep: вниз до шага, без float-мусора', () => {
    expect(roundDownToStep(100.004, 0.01)).toBe(100);
    expect(roundDownToStep(3.14159, 0.05)).toBeCloseTo(3.1, 8);
    expect(roundDownToStep(0.99, 0.01)).toBe(0.99);
  });

  it('roundToTick: к ближайшему тику', () => {
    expect(roundToTick(10.123, 0.01)).toBe(10.12);
    expect(roundToTick(10.126, 0.01)).toBe(10.13);
  });
});

describe('openReal', () => {
  it('плечо → лимитный вход со стопом → reduce-only TP1/TP2/TP3', async () => {
    const calls: { path: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ path: u.pathname, body: String(init.body ?? '') });
      if (u.pathname === '/v5/market/instruments-info') {
        return okResult({ list: [{ priceFilter: { tickSize: '0.0001' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01' } }] });
      }
      if (u.pathname === '/v5/position/set-leverage') return okResult({ buyLeverage: '5', sellLeverage: '5' });
      if (u.pathname === '/v5/order/create') return okResult({ orderId: `oid-${calls.length}` });
      return okResult({});
    }));

    const cred = { key: 'K', secret: 'S', testnet: true };
    const res = await openReal(cred, { category: 'linear', symbol: 'BTCUSDT', plan: plan(), riskMoney: 1000, leverage: 5 });

    expect(calls[0].path).toBe('/v5/market/instruments-info');
    expect(calls[1].path).toBe('/v5/position/set-leverage');
    expect(calls[1].body).toContain('"buyLeverage":"5"');
    expect(calls[1].body).toContain('"sellLeverage":"5"');

    const entry = calls[2];
    expect(entry.path).toBe('/v5/order/create');
    expect(entry.body).toContain('"side":"Buy"');
    expect(entry.body).toContain('"orderType":"Limit"');
    expect(entry.body).toContain('"qty":"100"');
    expect(entry.body).toContain('"price":"100.00000000"');
    expect(entry.body).toContain('"stopLoss":"90.00000000"');
    expect(entry.body).toContain('"slTriggerBy":"MarkPrice"');
    expect(entry.body).toContain('"timeInForce":"GTC"');
    expect(entry.body).not.toContain('"reduceOnly":true');

    const tps = calls.slice(3);
    expect(tps).toHaveLength(3);
    expect(tps[0].body).toContain('"qty":"70"');
    expect(tps[0].body).toContain('"price":"110.00000000"');
    expect(tps[1].body).toContain('"qty":"20"');
    expect(tps[1].body).toContain('"price":"120.00000000"');
    expect(tps[2].body).toContain('"qty":"10"');
    expect(tps[2].body).toContain('"price":"130.00000000"');
    for (const tp of tps) {
      expect(tp.body).toContain('"reduceOnly":true');
      expect(tp.body).toContain('"timeInForce":"PostOnly"');
      expect(tp.body).toContain('"side":"Sell"');
    }

    expect(res.qty).toBe(100);
    expect(res.tpOrders).toHaveLength(3);
    expect(res.margin).toBe(2000);
  });

  it('wait-план → ошибка без ордеров', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResult({})));
    const cred = { key: 'K', secret: 'S', testnet: false };
    await expect(openReal(cred, { category: 'linear', symbol: 'BTCUSDT', plan: plan({ direction: 'wait' }), riskMoney: 1000, leverage: 5 }))
      .rejects.toThrow(/направления/);
  });

  it('слишком маленький размер → ошибка до set-leverage и до ордеров', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url));
      paths.push(u.pathname);
      if (u.pathname === '/v5/market/instruments-info') {
        // Дешёвый символ: цена 0.25, шаг 1 шт, минимум биржи 5 $ на заявку.
        return okResult({ list: [{ priceFilter: { tickSize: '0.0001' }, lotSizeFilter: { qtyStep: '1', minOrderQty: '1' } }] });
      }
      return okResult({});
    }));

    const cred = { key: 'K', secret: 'S', testnet: true };
    // Цена 0.248, шаг 1 шт: риск 0.5 $ → позиция ~51.6 $, раннер 10 % = 20 шт = 4.96 $ < 5 $.
    await expect(openReal(cred, {
      category: 'linear', symbol: 'WIFUSDT',
      plan: plan({ price: 0.248, entryLow: 0.243, entryHigh: 0.253, entryMid: 0.248, stop: 0.2456, riskDist: 0.0024, tp1: 0.2505, tp2: 0.253, tp3: 0.2555 }),
      riskMoney: 0.5, leverage: 5,
    })).rejects.toThrow(/Минимум для лесенки 70\/20\/10/);

    expect(paths).toEqual(['/v5/market/instruments-info']);
  });

  it('отказ одного TP → откат: вход и выставленные TP снимаются', async () => {
    const calls: { path: string; body: string }[] = [];
    let created = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ path: u.pathname, body: String(init.body ?? '') });
      if (u.pathname === '/v5/market/instruments-info') {
        return okResult({ list: [{ priceFilter: { tickSize: '0.01' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01' } }] });
      }
      if (u.pathname === '/v5/position/set-leverage') return okResult({ buyLeverage: '5', sellLeverage: '5' });
      if (u.pathname === '/v5/order/create') {
        created += 1;
        // Вход и TP1 проходят, TP2 отклоняется биржей.
        if (created === 3) return { ok: true, text: async () => JSON.stringify({ retCode: 110003, retMsg: 'Order qty is too small', result: {} }) };
        return okResult({ orderId: `oid-${created}` });
      }
      return okResult({});
    }));

    const cred = { key: 'K', secret: 'S', testnet: true };
    await expect(openReal(cred, { category: 'linear', symbol: 'ETHUSDT', plan: plan(), riskMoney: 1000, leverage: 5 }))
      .rejects.toThrow(/откат/);

    const cancels = calls.filter((c) => c.path === '/v5/order/cancel');
    // Снимаем вход (oid-1) и уже выставленный TP1 (oid-2).
    expect(cancels).toHaveLength(2);
    expect(cancels[0].body).toContain('oid-1');
    expect(cancels[1].body).toContain('oid-2');
  });
});

describe('planLadder (пред-полётная проверка лесенки)', () => {
  const cheap: InstrumentInfo = { tickSize: 0.0001, qtyStep: 1, minOrderQty: 1, minNotional: 5 };
  const btc: InstrumentInfo = { tickSize: 0.1, qtyStep: 0.001, minOrderQty: 0.001, minNotional: 5 };

  it('дешёвый символ: риск 0.6 $ → позиция 62 $ (250 шт), все TP проходят', () => {
    const l = planLadder(cheap, 0.248, 0.6, 0.0024);
    expect(l.problems).toEqual([]);
    expect(l.qty).toBe(250);
    expect(l.notional).toBeCloseTo(62, 6);
    expect(l.slices.map((s) => s.frac)).toEqual([0.7, 0.2, 0.1]);
    expect(l.slices.every((s) => s.ok)).toBe(true);
  });

  it('дешёвый символ: риск 0.5 $ → раннер 4.96 $ упирается в минимум 5 $', () => {
    const l = planLadder(cheap, 0.248, 0.5, 0.0024);
    expect(l.qty).toBe(208);
    expect(l.slices[2].qty).toBe(20);
    expect(l.slices[2].ok).toBe(false);
    expect(l.problems.join(' ')).toMatch(/TP3 \(10%\)/);
    // Минимум: 210 шт = 52.08 $ позиции, риск 0.504 $ (срезы округляются вниз по шагу 1).
    expect(l.minQty).toBe(210);
    expect(l.minNotional).toBeCloseTo(52.08, 6);
    expect(l.minRisk).toBeCloseTo(0.504, 6);
  });

  it('BTCUSDT: шаг 0.001 → лесенка требует позиции от 850 $ (10 шагов)', () => {
    const l = planLadder(btc, 85_000, 1.5, 246);
    expect(l.problems.length).toBeGreaterThan(0);
    expect(l.minQty).toBe(0.01);
    expect(l.minNotional).toBe(850);
    expect(l.minRisk).toBeCloseTo(2.46, 6);
    // Риск 3 $ позицию делает валидной по всем срезам.
    expect(planLadder(btc, 85_000, 3, 246).problems).toEqual([]);
  });

  it('без ограничения по номиналу (minNotional 0) достаточно шага', () => {
    const info: InstrumentInfo = { tickSize: 0.0001, qtyStep: 0.01, minOrderQty: 0.01, minNotional: 0 };
    const l = planLadder(info, 0.25, 0.02, 0.0024);
    expect(l.problems).toEqual([]);
    // Минимум задаёт самый мелкий срез: 0.01 шт / 0.1 = 0.1 шт позиции = 0.025 $.
    expect(l.minQty).toBe(0.1);
    expect(l.minNotional).toBeCloseTo(0.025, 6);
  });

  it('нулевая дистанция до стопа → проблема, ноль ордеров', () => {
    const l = planLadder(cheap, 0.248, 1, 0);
    expect(l.qty).toBe(0);
    expect(l.problems.length).toBeGreaterThan(0);
    expect(l.minRisk).toBe(0);
  });
});