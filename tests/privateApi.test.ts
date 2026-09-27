import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildQuery,
  clearCredentials,
  fetchWalletBalance,
  hmacHex,
  loadCredentials,
  requestPrivate,
  saveCredentials,
} from '../src/api/privateApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hmacHex', () => {
  it('совпадает с node:crypto HMAC-SHA256 (эталонная схема Bybit)', async () => {
    const secret = 's3cret';
    const message = '1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C';
    const expected = createHmac('sha256', secret).update(message).digest('hex');
    expect(await hmacHex(secret, message)).toBe(expected);
  });
});

describe('buildQuery', () => {
  it('пропускает пустые/undefined и сортирует ключи (URLSearchParams)', () => {
    expect(buildQuery({ b: '2', a: '1', x: undefined, y: '' })).toBe('a=1&b=2');
  });
});

describe('requestPrivate', () => {
  const mockFetch = (resultJson: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(resultJson),
    })));
  };

  it('GET: подпись = hmac(timestamp+key+recvWindow+query), тестнет-домен', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      captured = { url: String(url), headers: init.headers as Record<string, string> };
      return { ok: true, text: async () => JSON.stringify({ retCode: 0, retMsg: 'OK', result: { ping: 'pong' } }) };
    }));
    const result = await requestPrivate<{ ping: string }>(
      'GET', '/v5/order/realtime', { category: 'linear', symbol: 'BTCUSDT' },
      { key: 'APIKEY0001', secret: 'SECRET', testnet: true },
    );
    expect(result.ping).toBe('pong');
    expect(captured!.url).toBe('https://api-testnet.bybit.com/v5/order/realtime?category=linear&symbol=BTCUSDT');
    const ts = captured!.headers['X-BAPI-TIMESTAMP'];
    const query = 'category=linear&symbol=BTCUSDT';
    const expected = createHmac('sha256', 'SECRET').update(`${ts}APIKEY00015000${query}`).digest('hex');
    expect(captured!.headers['X-BAPI-SIGN']).toBe(expected);
  });

  it('POST: подпись включает JSON-тело, заголовки для приватного запроса', async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return { ok: true, text: async () => JSON.stringify({ retCode: 0, retMsg: 'OK', result: { orderId: '1' } }) };
    }));
    const body = { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: '0.001' };
    await requestPrivate('POST', '/v5/order/create', body, { key: 'K', secret: 'S', testnet: false });
    const ts = captured!.headers['X-BAPI-TIMESTAMP'];
    expect(captured!.headers['Content-Type']).toBe('application/json');
    const expected = createHmac('sha256', 'S').update(`${ts}K5000${captured!.body}`).digest('hex');
    expect(captured!.headers['X-BAPI-SIGN']).toBe(expected);
  });

  it('retCode != 0 → бросает с ret-сообщением', async () => {
    mockFetch({ retCode: 10004, retMsg: 'signature error', result: {} });
    await expect(requestPrivate('GET', '/v5/x', {}, { key: 'K', secret: 'S', testnet: false })).rejects.toThrow(/signature error/);
  });

  it('не-JSON ответ → HTTP ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' })));
    await expect(requestPrivate('GET', '/v5/x', {}, { key: 'K', secret: 'S', testnet: false })).rejects.toThrow(/HTTP 502/);
  });

  it('10002 — подсказка про ключ/время', async () => {
    mockFetch({ retCode: 10002, retMsg: 'invalid request', result: {} });
    await expect(requestPrivate('GET', '/v5/x', {}, { key: 'K', secret: 'S', testnet: false })).rejects.toThrow(/ключ/);
  });
});

describe('wallet / credentials', () => {
  it('fetchWalletBalance парсит result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          accountType: 'UNIFIED',
          totalEquity: '1234.5',
          totalWalletBalance: '1200',
          totalMarginBalance: '300',
          list: [{ coin: 'USDT', walletBalance: '1200', equity: '1234.5', availableToWithdraw: '900', usdValue: '1234.5' }],
        },
      }),
    })));
    const w = await fetchWalletBalance({ key: 'K', secret: 'S', testnet: false });
    expect(w.totalEquity).toBe(1234.5);
    expect(w.coins[0]).toMatchObject({ coin: 'USDT', walletBalance: 1200 });
  });

  it('credentials: без localStorage load → null, save/clear безопасны', () => {
    expect(loadCredentials()).toBeNull();
    saveCredentials({ key: 'K', secret: 'S', testnet: false });
    clearCredentials();
    expect(loadCredentials()).toBeNull();
  });
});