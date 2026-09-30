import { describe, expect, it } from 'vitest';
import {
  bySymbolHistory,
  executionToTrade,
  exitKindOf,
  mergeExecutions,
  realHistorySummary,
  realizedNet,
  startOfToday,
  todayRealPnl,
} from '../src/lib/realHistory';
import type { ApiExecution } from '../src/api/privateApi';

const exec = (over: Partial<ApiExecution>): ApiExecution => ({
  execId: 'e1', orderId: 'o1', symbol: 'WIFUSDT', side: 'Buy', qty: 100, price: 0.5,
  fee: 0.01, execPnl: 0, execType: 'Trade', execTime: 1_700_000_000_000,
  orderType: 'Limit', orderLinkId: '', ...over,
});

describe('realHistory: исполнения → сделки', () => {
  it('exitKindOf: вход/TP/стоп/ручное распознаются по orderLinkId и типу', () => {
    expect(exitKindOf(exec({ orderLinkId: 'ent-x' }))).toBe('entry');
    expect(exitKindOf(exec({ side: 'Sell', orderLinkId: 'tp-x' }))).toBe('tp');
    expect(exitKindOf(exec({ side: 'Sell', orderLinkId: 'cl-x' }))).toBe('manual');
    expect(exitKindOf(exec({ side: 'Sell', orderType: 'Market', execPnl: -2 }))).toBe('stop');
    expect(exitKindOf(exec({ side: 'Sell', orderType: 'Limit', execPnl: 1 }))).toBe('tp');
  });

  it('executionToTrade: сторона, цена, qty, комиссия копируются', () => {
    const t = executionToTrade(exec({ side: 'Sell', qty: 50, price: 0.6, fee: 0.02, execTime: 123 }));
    expect(t.side).toBe('Sell');
    expect(t.qty).toBe(50);
    expect(t.price).toBe(0.6);
    expect(t.fee).toBe(0.02);
    expect(t.execTime).toBe(123);
  });

  it('mergeExecutions: дедуп по execId, новые сверху', () => {
    const current = [executionToTrade(exec({ execId: 'e1', execTime: 1 }))];
    const merged = mergeExecutions(current, [
      exec({ execId: 'e1', execTime: 1 }),       // дубль — пропущен
      exec({ execId: 'e2', execTime: 2, qty: 10, price: 0.7 }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].execId).toBe('e2');
  });

  it('mergeExecutions: грязные филлы (без qty/цены) не попадают', () => {
    const merged = mergeExecutions([], [exec({ execId: 'e1', qty: 0 })]);
    expect(merged).toHaveLength(0);
  });

  it('bySymbolHistory: лонг вход дешевле выхода → P&L в плюсе минус комиссии', () => {
    const list = [
      executionToTrade(exec({ execId: 'e1', side: 'Buy', qty: 100, price: 10, fee: 0.1, execTime: 1, orderLinkId: 'ent-1' })),
      executionToTrade(exec({ execId: 'e2', side: 'Sell', qty: 100, price: 11, fee: 0.11, execTime: 2, orderLinkId: 'tp-1' })),
    ];
    const sh = bySymbolHistory(list);
    expect(sh).toHaveLength(1);
    const s = sh[0];
    expect(s.direction).toBe('long');
    expect(s.avgEntry).toBe(10);
    expect(s.avgExit).toBe(11);
    // (11−10)×100 − 0.21 комиссии = 99.79
    expect(s.pnl).toBeCloseTo(99.79, 6);
    expect(s.entries).toBe(1);
    expect(s.exits).toBe(1);
  });

  it('bySymbolHistory: убыток шорта считается верно (вход дороже выхода)', () => {
    const list = [
      executionToTrade(exec({ execId: 's1', side: 'Sell', qty: 10, price: 100, fee: 0.05, execTime: 1 })),
      executionToTrade(exec({ execId: 's2', side: 'Buy', qty: 10, price: 110, fee: 0.05, execTime: 2 })),
    ];
    const s = bySymbolHistory(list)[0];
    expect(s.direction).toBe('short');
    // шорт: номинал входа(продажа) 1000 − номинал выхода(покупка) 1100 = −100 − 0.10 = −100.10
    expect(s.pnl).toBeCloseTo(-100.1, 6);
  });

  it('realHistorySummary: сводка и посимвольные циклы', () => {
    const list = [
      executionToTrade(exec({ execId: 'e1', side: 'Buy', qty: 4, price: 9, fee: 0.01, execTime: 1, orderLinkId: 'ent-1' })),
      executionToTrade(exec({ execId: 'e2', side: 'Sell', qty: 4, price: 10, fee: 0.01, execTime: 2, orderLinkId: 'tp-1' })),
    ];
    const s = realHistorySummary(list);
    expect(s.symbols).toBe(1);
    expect(s.trades).toBe(2);
    expect(s.pnl).toBeCloseTo(3.98, 6);
    expect(s.bySymbol[0].symbol).toBe('WIFUSDT');
  });

  it('realizedNet: P&L за вычетом комиссии (номинал выхода − номинал входа − fees)', () => {
    expect(realizedNet(1100, 1000, 0.5)).toBeCloseTo(99.5, 6);
  });

  it('startOfToday: начало локального дня', () => {
    const now = new Date(2026, 8, 30, 14, 30, 0).getTime(); // 30.09.2026 14:30
    const d = new Date(startOfToday(now));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('todayRealPnl: учитывает только циклы, закрытые сегодня', () => {
    const day = new Date(2026, 8, 30, 12, 0, 0).getTime();
    const yesterday = day - 24 * 3600 * 1000;
    const list = [
      // Закрытый сегодня: вход 10 → выход 11 = +100 − комиссии 0.2 = +99.8
      executionToTrade(exec({ execId: 't1', side: 'Buy', qty: 100, price: 10, fee: 0.1, execTime: day - 3600_000, orderLinkId: 'ent-1' })),
      executionToTrade(exec({ execId: 't2', side: 'Sell', qty: 100, price: 11, fee: 0.1, execTime: day, orderLinkId: 'tp-1' })),
      // Закрытый вчера — не должен попасть в «сегодня».
      executionToTrade(exec({ execId: 'y1', symbol: 'BTCUSDT', side: 'Buy', qty: 1, price: 100, fee: 0.01, execTime: yesterday - 3600_000 })),
      executionToTrade(exec({ execId: 'y2', symbol: 'BTCUSDT', side: 'Sell', qty: 1, price: 101, fee: 0.01, execTime: yesterday })),
    ];
    const pnl = todayRealPnl(list, day);
    expect(pnl).toBeCloseTo(99.8, 6);
  });

  it('todayRealPnl: без закрытых сегодня сделок — 0', () => {
    const day = new Date(2026, 8, 30, 12, 0, 0).getTime();
    const yesterday = day - 24 * 3600 * 1000;
    const list = [
      executionToTrade(exec({ execId: 'y1', side: 'Buy', qty: 1, price: 100, fee: 0.01, execTime: yesterday - 3600_000 })),
      executionToTrade(exec({ execId: 'y2', side: 'Sell', qty: 1, price: 101, fee: 0.01, execTime: yesterday })),
    ];
    expect(todayRealPnl(list, day)).toBe(0);
  });

  it('открытая позиция (вход без выхода) не попадает в реализованный P&L', () => {
    const day = new Date(2026, 8, 30, 12, 0, 0).getTime();
    // Только вход, выхода нет — позиция ещё открыта, P&L не реализован.
    const list = [
      executionToTrade(exec({ execId: 'o1', side: 'Sell', qty: 0.14, price: 4000, fee: 0.01, execTime: day, orderLinkId: 'ent-1' })),
    ];
    const sh = bySymbolHistory(list);
    expect(sh).toHaveLength(0);
    expect(todayRealPnl(list, day)).toBe(0);
    expect(realHistorySummary(list).pnl).toBe(0);
  });

  it('закрытая + открытая позиция: P&L только по закрытой', () => {
    const day = new Date(2026, 8, 30, 12, 0, 0).getTime();
    const list = [
      // закрытая: вход → выход = +99.8
      executionToTrade(exec({ execId: 'c1', side: 'Buy', qty: 100, price: 10, fee: 0.1, execTime: day - 3600_000, orderLinkId: 'ent-1' })),
      executionToTrade(exec({ execId: 'c2', side: 'Sell', qty: 100, price: 11, fee: 0.1, execTime: day, orderLinkId: 'tp-1' })),
      // открытая (вход без выхода) — не считается
      executionToTrade(exec({ execId: 'o1', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 200, fee: 0.1, execTime: day, orderLinkId: 'ent-2' })),
    ];
    const sh = bySymbolHistory(list);
    expect(sh).toHaveLength(1);
    expect(sh[0].symbol).toBe('WIFUSDT');
    expect(todayRealPnl(list, day)).toBeCloseTo(99.8, 6);
  });
});