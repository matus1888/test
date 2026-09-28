// WsConnection: refcount подписок, auth-рукопожатие приватного канала, пауза реконнекта,
// heartbeat ping. Глобальная заглушка сокета вместо реального WebSocket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsConnection, chunkArgs, type WsSocket } from '../src/api/ws';

class FakeSocket implements WsSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(null);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }

  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeFactory(sockets: FakeSocket[]) {
  return (): WsSocket => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
}

function conn(options: { auth?: () => Promise<{ key: string; expires: number; signature: string } | null>; skipAuth?: boolean; ping?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const c = new WsConnection({
    url: 'wss://example.test',
    factory: makeFactory(sockets),
    jitter: false,
    ...(options.ping != null ? { pingIntervalMs: options.ping } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.skipAuth != null ? { skipAuth: options.skipAuth } : {}),
  });
  return { c, sockets };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chunkArgs', () => {
  it('не режет список, когда всё влезает', () => {
    expect(chunkArgs(['a.BTCUSDT', 'b.ETHUSDT'], 21_000, Infinity)).toEqual([['a.BTCUSDT', 'b.ETHUSDT']]);
  });

  it('режет по числу args (spot: 10 за раз)', () => {
    const topics = Array.from({ length: 25 }, (_, i) => `t.${i}`);
    const frames = chunkArgs(topics, 21_000, 10);
    expect(frames.length).toBe(3);
    expect(frames[0]).toHaveLength(10);
    expect(frames[2]).toHaveLength(5);
  });

  it('режет по бюджету символов', () => {
    const topics = ['abc', 'def', 'ghi'];
    const frames = chunkArgs(topics, 8, Infinity);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.flat()).toEqual(topics);
  });
});

describe('подключение cокета', () => {
  it('поднимает сокет только при первой подписке', () => {
    const { c, sockets } = conn();
    expect(sockets).toHaveLength(0);
    c.subscribe('tickers.BTCUSDT', () => {});
    expect(sockets).toHaveLength(1);
    expect(c.status).toBe('connecting');
  });

  it('после открытия отправляет подписки одной рамкой', () => {
    const { c, sockets } = conn();
    c.subscribe('tickers.BTCUSDT', () => {});
    c.subscribe('tickers.ETHUSDT', () => {});
    sockets[0].open();
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT', 'tickers.ETHUSDT'] }),
    ]);
    expect(c.isReady).toBe(true);
  });

  it('до открытия копит темы и отправляет их после', () => {
    const { c, sockets } = conn();
    c.subscribe('tickers.SOLUSDT', () => {});
    c.subscribe('tickers.XRPUSDT', () => {});
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ op: 'subscribe', args: ['tickers.SOLUSDT', 'tickers.XRPUSDT'] }),
    ]);
  });

  it('refcount: два подписчика — одна тема, уход последнего — unsubscribe', () => {
    const { c, sockets } = conn();
    const a = () => {};
    const b = () => {};
    const offA = c.subscribe('tickers.BTCUSDT', a);
    offA(); // ушёл первый — тема должна остаться, сокет без подписчиков закрылся
    expect(c.subscribers('tickers.BTCUSDT')).toBe(0);
    expect(c.status).toBe('idle');
    expect(sockets[0].readyState).toBe(3);
    const offB = c.subscribe('tickers.BTCUSDT', b);
    expect(sockets).toHaveLength(2); // новое соединение под новую подписку
    sockets[1].open();
    expect(sockets[1].sent).toEqual([JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] })]);
    offB();
    expect(sockets[1].sent).toContain(JSON.stringify({ op: 'unsubscribe', args: ['tickers.BTCUSDT'] }));
    expect(c.status).toBe('idle'); // подписчиков нет — сокет закрылся
  });

  it('доставляет сообщение только своим подписчикам', () => {
    const { c, sockets } = conn();
    const seen: unknown[] = [];
    c.subscribe('tickers.BTCUSDT', (d) => seen.push(d));
    c.subscribe('tickers.ETHUSDT', () => {});
    sockets[0].open();
    sockets[0].frame({ topic: 'tickers.BTCUSDT', data: { lastPrice: '70000' } });
    expect(seen).toEqual([{ lastPrice: '70000' }]);
  });

  it('ping уходит по таймеру, pong не тревожит подписчиков', () => {
    const { c, sockets } = conn({ ping: 20_000 });
    const seen: unknown[] = [];
    c.subscribe('tickers.BTCUSDT', (d) => seen.push(d));
    sockets[0].open();
    expect(sockets[0].sent.some(s => s.includes('"op":"ping"'))).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(sockets[0].sent.some(s => s.includes('"op":"ping"'))).toBe(true);
    sockets[0].frame({ op: 'pong' });
    sockets[0].frame({ op: 'ping', ret_msg: 'pong' });
    expect(seen).toEqual([]);
  });
});

describe('переподключение', () => {
  it('создаёт новый сокет с той же подпиской после обрыва', async () => {
    const { c, sockets } = conn();
    c.subscribe('tickers.BTCUSDT', () => {});
    sockets[0].open();
    sockets[0].close();
    expect(c.status).toBe('closed');
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); // первая пауза — 1 c
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent).toContain(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] }));
  });

  it('коленный бэк-офф: вторая пауза 2 c, третья — 4 c', async () => {
    const { c, sockets } = conn();
    c.subscribe('tickers.BTCUSDT', () => {});
    sockets[0].open();
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].close();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2); // 2 c ещё не прошло
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    sockets[2].close();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets).toHaveLength(4);
  });

  it('без подписчиков не реконнектится', async () => {
    const { c, sockets } = conn();
    const off = c.subscribe('tickers.BTCUSDT', () => {});
    sockets[0].open();
    off();
    expect(sockets).toHaveLength(1);
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(c.status).toBe('idle');
  });
});

describe('приватный канал', () => {
  const AUTH = () => Promise.resolve({ key: 'k', expires: 1_700_000_000_000, signature: 'sig' });

  it('шлёт auth до подписок и ждёт подтверждения', async () => {
    const { c, sockets } = conn({ auth: AUTH });
    c.subscribe('position', () => {});
    sockets[0].open();
    await Promise.resolve();
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ op: 'auth', args: ['k', 1_700_000_000_000, 'sig'] }),
    ]);
    expect(c.isReady).toBe(false);
    sockets[0].frame({ success: true, op: 'auth', conn_id: 'x' });
    expect(sockets[0].sent).toContain(JSON.stringify({ op: 'subscribe', args: ['position'] }));
    expect(c.isReady).toBe(true);
  });

  it('при неудачном auth переподключается', async () => {
    const { c, sockets } = conn({ auth: () => Promise.resolve(null) });
    c.subscribe('position', () => {});
    sockets[0].open();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('отключаемый auth (тесты/режим без ключей) — подписки сразу', () => {
    const { c, sockets } = conn({ auth: AUTH, skipAuth: true });
    c.subscribe('position', () => {});
    sockets[0].open();
    expect(sockets[0].sent).toEqual([JSON.stringify({ op: 'subscribe', args: ['position'] })]);
  });
});