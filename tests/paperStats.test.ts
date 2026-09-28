// Аналитика по закрытым (срезы, кривая) и журнал сигналов.

import { describe, expect, it, beforeEach } from 'vitest';
import { closedStats, closedSummary, atrPctOf, confBucket, atrBucket } from '../src/lib/paperStats';
import { recordSignalSnapshot, loadSignalLog, clearSignalLog } from '../src/lib/signalLog';
import type { PaperPosition } from '../src/lib/paper';
import { totalPnlOf } from '../src/lib/paper';
import type { Row } from '../src/lib/screener';

// node-окружение vitest не имеет localStorage — поднимаем простой in-memory.
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string): void { this.m.delete(k); }
  setItem(k: string, v: string): void { this.m.set(k, v); }
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = new MemStorage();
});

const closed = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: 'p1',
  symbol: 'BTCUSDT',
  category: 'linear',
  interval: '5',
  direction: 'long',
  entryPrice: 60000,
  stake: 100,
  leverage: 3,
  qty: 0.01,
  stop: 59000,
  tp1: 61200,
  tp2: 62400,
  tp3: 63600,
  entryLow: 59800,
  entryHigh: 60200,
  confidence: 88,
  openedAt: 1700000000000,
  status: 'closed',
  closeReason: 'tp3',
  closePrice: 63600,
  closedAt: 1700003600000,
  ...over,
});

describe('paperStats: срезы', () => {
  it('считает срезы по направлению с дельтой R и P&L', () => {
    const long = closed();
    const short = closed({ id: 'p2', direction: 'short', closePrice: 61000, closeReason: 'stop' });
    const s = closedStats([long, short])!;
    const byDir = s.byDirection;
    expect(byDir).toHaveLength(2);
    const l = byDir.find((r) => r.label === 'long')!;
    expect(l.n).toBe(1);
    expect(l.wins).toBe(1); // tp3 в плюсе
    const sh = byDir.find((r) => r.label === 'short')!;
    expect(sh.n).toBe(1);
    expect(sh.wins).toBe(0);
  });

  it('сортирует срезы по количеству, потом по сумме R', () => {
    const a = closed({ id: 'a', direction: 'long' });
    const b = closed({ id: 'b', direction: 'short', closePrice: 59000, closeReason: 'stop' });
    const s = closedStats([a, b])!;
    expect(s.byDirection.map((r) => r.label)).toEqual(['long', 'short']);
  });

  it('возвращает null без закрытых', () => {
    expect(closedStats([])).toBeNull();
  });

  it('кривая доходности строится по времени закрытия', () => {
    const p1 = closed({ id: '1', closedAt: 100, closePrice: 63600 });
    const p2 = closed({ id: '2', closedAt: 200, closePrice: 59000 });
    const s = closedStats([p2, p1])!; // в неверном порядке
    expect(s.equity.map((e) => e.time)).toEqual([100, 200]);
    // кумулятивно: вторая точка = первая + P&L второй сделки
    const firstNet = totalPnlOf(p1, 63600).net;
    const secondNet = totalPnlOf(p2, 59000).net;
    expect(s.equity[0].cum).toBeCloseTo(firstNet, 8);
    expect(s.equity[1].cum).toBeCloseTo(firstNet + secondNet, 8);
  });

  it('summary считает общие числа', () => {
    const s = closedSummary([closed({ id: '1', closePrice: 63600 }), closed({ id: '2', closePrice: 59000 })]);
    expect(s.n).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.winratePct).toBe(50);
  });
});

describe('paperStats: бакеты', () => {
  it('ATR% из стопа и входа', () => {
    expect(atrPctOf({ entryPrice: 100, stop: 99 })).toBeCloseTo(0.556, 1); // (1/1.8)/100*100
  });
  it('confBucket по границам', () => {
    expect(confBucket(59)).toBe('<60');
    expect(confBucket(88)).toBe('85-92');
    expect(confBucket(95)).toBe('>=92');
  });
  it('atrBucket', () => {
    expect(atrBucket(0.2)).toBe('<0.5%');
    expect(atrBucket(2.5)).toBe('>=2%');
  });
});

describe('signalLog', () => {
  beforeEach(() => clearSignalLog());
  const NOW = Date.now();

  const row = (symbol: string, direction: 'long' | 'short', confidence: number, priority: number): Row =>
    ({
      symbol, direction, confidence, priority,
      category: 'linear', interval: '5',
      price: 1, turnover: 1_000_000, fundingRate: null, klineLoading: false,
    }) as unknown as Row;

  it('пишет снимок и читает его', () => {
    const rows = [row('BTCUSDT', 'long', 90, 10), row('ETHUSDT', 'short', 85, 5)];
    recordSignalSnapshot(rows, 'linear', '5', NOW);
    const log = loadSignalLog();
    expect(log).toHaveLength(1);
    expect(log[0].setups[0]).toMatchObject({ symbol: 'BTCUSDT', direction: 'long', confidence: 90 });
  });

  it('сортирует сетапы по приоритету и режет топ-20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`S${i}`, 'long', 80 + (i % 10), i));
    recordSignalSnapshot(rows, 'linear', '5', NOW);
    const log = loadSignalLog();
    expect(log[0].setups).toHaveLength(20);
    const p = log[0].setups.map((s) => s.priority);
    expect(p).toEqual([...p].sort((a, b) => b - a));
  });

  it('не дублирует одинаковый кадр за минуту, но пишет следующий прогон', () => {
    const rows = [row('BTCUSDT', 'long', 90, 10)];
    recordSignalSnapshot(rows, 'linear', '5', NOW);
    recordSignalSnapshot(rows, 'linear', '5', NOW + 1000);
    expect(loadSignalLog()).toHaveLength(1);
    recordSignalSnapshot(rows, 'linear', '5', NOW + 130_000); // > 2 мин
    expect(loadSignalLog()).toHaveLength(2);
  });

  it('игнорирует кадр без направленных сетапов', () => {
    recordSignalSnapshot([], 'linear', '5', NOW);
    expect(loadSignalLog()).toHaveLength(0);
  });
});