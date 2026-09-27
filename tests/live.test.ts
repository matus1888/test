import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReal, roundDownToStep, roundToTick } from '../src/api/live';
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
});