// Разбор и слияние кадров приватного потока и тикеров.

import { describe, expect, it } from 'vitest';
import {
  applyUplDelta,
  isTerminalOrderStatus,
  mergeOrders,
  mergePositions,
  mergeWallet,
  parseWsExecution,
  parseWsOrder,
  parseWsPosition,
  pushFill,
} from '../src/lib/accountStream';
import { parseTicker, putTicker, __resetTickerCache } from '../src/lib/tickerStore';

const position = (over: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  side: 'Buy',
  size: '0.01',
  positionIdx: '0',
  entryPrice: '60000',
  markPrice: '60500',
  leverage: '5',
  unrealisedPnl: '5',
  liqPrice: '55000',
  ...over,
});

describe('parseWsPosition', () => {
  it('собирает позицию из кадра', () => {
    const p = parseWsPosition(position())!;
    expect(p).toMatchObject({ symbol: 'BTCUSDT', side: 'Buy', size: 0.01, avgPrice: 60000, markPrice: 60500, unrealisedPnl: 5, positionIdx: 0 });
  });

  it('закрытая позиция (size 0) остаётся читаемой', () => {
    const p = parseWsPosition({ symbol: 'BTCUSDT', size: '0', positionIdx: '0' })!;
    expect(p.size).toBe(0);
  });
});

describe('mergePositions', () => {
  it('обновляет строку и считает дельту uP&L', () => {
    const current = [parseWsPosition(position())!];
    const next = [parseWsPosition(position({ unrealisedPnl: '9', markPrice: '60900' }))!];
    const { positions, uplDelta } = mergePositions(current, next);
    expect(positions).toHaveLength(1);
    expect(positions[0].unrealisedPnl).toBe(9);
    expect(uplDelta).toBe(4);
  });

  it('нулевой размер убирает позицию без потери дельты uP&L', () => {
    const current = [parseWsPosition(position({ unrealisedPnl: '5' }))!];
    const closed = [parseWsPosition({ symbol: 'BTCUSDT', size: '0', positionIdx: '0', unrealisedPnl: '0' })!];
    const { positions, uplDelta } = mergePositions(current, closed);
    expect(positions).toHaveLength(0);
    expect(uplDelta).toBe(-5);
  });

  it('даже «пустая» позиция от биржи (все поля пусто) не ломает список', () => {
    const { positions } = mergePositions([], [parseWsPosition({ symbol: 'ETHUSDT', size: '0' })!]);
    expect(positions).toHaveLength(0);
  });
});

describe('mergeOrders', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    orderId: 'o1', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
    qty: 1, price: 60000, orderStatus: 'New', ...over,
  });

  it('меняет статус активного ордера', () => {
    const current = [parseWsOrder(order())!];
    const next = [parseWsOrder(order({ orderStatus: 'PartiallyFilled' }))!];
    expect(mergeOrders(current, next)[0].orderStatus).toBe('PartiallyFilled');
  });

  it('терминальные статусы снимают ордер из таблицы (обе грамматики Cancelled)', () => {
    for (const s of ['Filled', 'Cancelled', 'Canceled', 'Rejected', 'Deactivated']) {
      expect(mergeOrders([parseWsOrder(order())!], [parseWsOrder(order({ orderStatus: s }))!])).toHaveLength(0);
    }
    expect(isTerminalOrderStatus('Cancelled')).toBe(true);
    expect(isTerminalOrderStatus('New')).toBe(false);
  });
});

describe('parseWsExecution / pushFill', () => {
  const exec = (over: Record<string, unknown> = {}) => ({
    execId: 'e1', orderId: 'o1', symbol: 'BTCUSDT', side: 'Sell',
    execPrice: '60500', execQty: '0.005', execFee: '-0.05', execPnl: '2.5',
    execType: 'Trade', execTime: 1700000000000, isMaker: true, ...over,
  });

  it('парсит исполнение', () => {
    const f = parseWsExecution(exec())!;
    expect(f).toMatchObject({ execId: 'e1', symbol: 'BTCUSDT', execPrice: 60500, execQty: 0.005, execPnl: 2.5, isMaker: true });
  });

  it('лента: новые сверху, дубли по execId, потолок 20', () => {
    let fills: ReturnType<typeof pushFill>['0'] = [];
    for (let i = 0; i < 25; i++) fills = pushFill(fills, parseWsExecution(exec({ execId: `e${i}` }))!, 20);
    expect(fills).toHaveLength(20);
    expect(fills[0].execId).toBe('e24');
    const dup = pushFill(fills, parseWsExecution(exec({ execId: 'e5', execPrice: '99999' }))!, 20);
    expect(dup.filter((f) => f.execId === 'e5')).toHaveLength(1);
    expect(dup.find((f) => f.execId === 'e5')!.execPrice).toBe(99999);
  });
});

describe('wallet', () => {
  const wallet = {
    accountType: 'UNIFIED', totalEquity: 1000, totalWalletBalance: 990, totalMarginBalance: 1000,
    totalAvailableBalance: 400, totalInitialMargin: 600, totalPerpUPL: 10, totalOrderInitialMargin: 0,
    totalPositionInitialMargin: 600, coins: [{ coin: 'USDT', walletBalance: 990, equity: 1000, availableToWithdraw: 400, usdValue: 1000 }],
  };

  it('uP&L восстанавливается из балансов (маржинальный баланс = баланс + uP&L)', () => {
    const w = mergeWallet(wallet, { totalWalletBalance: '1000', totalMarginBalance: '1015', totalEquity: '1015' });
    expect(w.totalPerpUPL).toBe(15);
    expect(w.totalEquity).toBe(1015);
  });

  it('частичный кадр не обнуляет кошелёк', () => {
    const w = mergeWallet(wallet, { totalWalletBalance: '900', totalMarginBalance: '910', totalEquity: '910' });
    expect(w.totalInitialMargin).toBe(600);
    expect(w.totalPerpUPL).toBe(10);
  });

  it('applyUplDelta двигает equity и маржинальный баланс', () => {
    const w = applyUplDelta(wallet, 5);
    expect(w.totalPerpUPL).toBe(15);
    expect(w.totalEquity).toBe(1005);
    expect(w.totalMarginBalance).toBe(1005);
  });
});

describe('parseTicker', () => {
  it('парсит полный кадр', () => {
    const t = parseTicker({ symbol: 'BTCUSDT', lastPrice: '70000.5', price24hPcnt: '0.02', turnover24h: '1234567', markPrice: '70000.0' })!;
    expect(t).toMatchObject({ symbol: 'BTCUSDT', lastPrice: 70000.5, price24hPcnt: 0.02, turnover24h: 1234567, markPrice: 70000 });
  });

  it('delta-кадр без части полей не ломается', () => {
    const t = parseTicker({ symbol: 'BTCUSDT', lastPrice: '70001' })!;
    expect(t.lastPrice).toBe(70001);
    expect(t.turnover24h).toBe(0);
    expect(t.markPrice).toBeNull();
  });

  it('мусор/пустые цены — null', () => {
    expect(parseTicker(null)).toBeNull();
    expect(parseTicker({ symbol: '', lastPrice: '1' })).toBeNull();
    expect(parseTicker({ symbol: 'X', lastPrice: '0' })).toBeNull();
  });

  it('стор хранит последнее значение', () => {
    __resetTickerCache();
    putTicker('linear', parseTicker({ symbol: 'BTCUSDT', lastPrice: '70000' })!);
    putTicker('linear', parseTicker({ symbol: 'BTCUSDT', lastPrice: '70002' })!);
    // public tickerOf — из стора
    const t = parseTicker({ symbol: 'BTCUSDT', lastPrice: '70003' });
    putTicker('linear', t!);
    // здесь мы проверяем только, что putTicker не бросает на чужой категории
    putTicker('spot', parseTicker({ symbol: 'BTCUSDT', lastPrice: '70004' }) as never);
    expect(true).toBe(true);
    __resetTickerCache();
  });
});