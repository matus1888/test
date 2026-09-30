import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildQuery,
  cancelAll,
  clearCredentials,
  devCredentials,
  fetchActiveOrders,
  fetchWalletBalance,
  hasStoredCredentials,
  hmacHex,
  loadCredentials,
  parseDevCredentials,
  requestPrivate,
  RECV_WINDOW,
  saveCredentials,
  setLeverage,
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
    const expected = createHmac('sha256', 'SECRET').update(`${ts}APIKEY0001${RECV_WINDOW}${query}`).digest('hex');
    expect(captured!.headers['X-BAPI-SIGN']).toBe(expected);
    // Окно приёма — 10 с, а не 5000: на мобильной сети 5 с съедала задержка (живая ошибка 10002).
    expect(captured!.headers['X-BAPI-RECV-WINDOW']).toBe(String(RECV_WINDOW));
    expect(Number(RECV_WINDOW)).toBeGreaterThanOrEqual(10_000);
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
    const expected = createHmac('sha256', 'S').update(`${ts}K${RECV_WINDOW}${captured!.body}`).digest('hex');
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

  it('10002 — подсказка про время устройства (ключ тут ни при чём)', async () => {
    // 10002 = «timestamp outside of receive timestamp range»: клиент выравнивает часы
    // о время биржи и повторяет запрос, поэтому текст ошибки должен называть время.
    mockFetch({ retCode: 10002, retMsg: 'invalid request', result: {} });
    await expect(requestPrivate('GET', '/v5/x', {}, { key: 'K', secret: 'S', testnet: false }))
      .rejects.toThrow(/время устройства/);
  });

  it('10004 — подсказка про ключ/секрет', async () => {
    mockFetch({ retCode: 10004, retMsg: 'sign error', result: {} });
    await expect(requestPrivate('GET', '/v5/x', {}, { key: 'K', secret: 'S', testnet: false }))
      .rejects.toThrow(/ключ или секрет/);
  });
});

describe('широкие запросы без symbol (живая проверка mainnet)', () => {
  const capture = () => {
    const state: { url?: string; body?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      state.url = String(url);
      state.body = init.body ? String(init.body) : undefined;
      return { ok: true, text: async () => JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }) };
    }));
    return state;
  };
  const cred = { key: 'K', secret: 'S', testnet: false };

  it('order/realtime без символа → settleCoin=USDT (иначе 10001)', async () => {
    const s = capture();
    await fetchActiveOrders(cred, 'linear');
    expect(s.url).toBe('https://api.bybit.com/v5/order/realtime?category=linear&settleCoin=USDT');
  });

  it('order/realtime со символом → symbol, без settleCoin', async () => {
    const s = capture();
    await fetchActiveOrders(cred, 'linear', 'BTCUSDT');
    expect(s.url).toBe('https://api.bybit.com/v5/order/realtime?category=linear&symbol=BTCUSDT');
  });

  it('order/realtime для spot → baseCoin', async () => {
    const s = capture();
    await fetchActiveOrders(cred, 'spot');
    expect(s.url).toBe('https://api.bybit.com/v5/order/realtime?baseCoin=USDT&category=spot');
  });

  it('cancel-all без символа → settleCoin=USDT', async () => {
    const s = capture();
    await cancelAll(cred, 'linear');
    expect(s.body).toBe(JSON.stringify({ category: 'linear', settleCoin: 'USDT' }));
  });

  it('cancel-all со символом → symbol', async () => {
    const s = capture();
    await cancelAll(cred, 'linear', 'BTCUSDT');
    expect(s.body).toBe(JSON.stringify({ category: 'linear', symbol: 'BTCUSDT' }));
  });

  it('set-leverage: 110043 «leverage not modified» не считается ошибкой (плечо уже такое)', async () => {
    const state: { body?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      state.body = init.body ? String(init.body) : undefined;
      return { ok: true, text: async () => JSON.stringify({ retCode: 110043, retMsg: 'leverage not modified', result: {} }) };
    }));
    const k = { key: 'K', secret: 'S', testnet: false };
    await expect(setLeverage(k, { category: 'linear', symbol: 'BTCUSDT', leverage: 5 })).resolves.toBeUndefined();
    expect(state.body).toContain('"buyLeverage":"5"');
    expect(state.body).toContain('"sellLeverage":"5"');
  });
});

describe('wallet / credentials', () => {
  it('fetchWalletBalance парсит result (list[0] — аккаунт, list[0].coin — монеты)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [{
            accountType: 'UNIFIED',
            totalEquity: '1234.5',
            totalWalletBalance: '1200',
            totalMarginBalance: '300',
            coin: [{ coin: 'USDT', walletBalance: '1200', equity: '1234.5', availableToWithdraw: '900', usdValue: '1234.5' }],
          }],
        },
      }),
    })));
    const w = await fetchWalletBalance({ key: 'K', secret: 'S', testnet: false });
    expect(w.accountType).toBe('UNIFIED');
    expect(w.totalEquity).toBe(1234.5);
    expect(w.totalWalletBalance).toBe(1200);
    expect(w.coins[0]).toMatchObject({ coin: 'USDT', walletBalance: 1200 });
    // Поля маржи и uP&L: если биржа их не прислала — нули, не NaN (страница /real их рисует).
    expect(w.totalPerpUPL).toBe(0);
    expect(w.totalInitialMargin).toBe(0);
    // Доступно не пришло — считаем от equity минус занятая маржа (0).
    expect(w.totalAvailableBalance).toBe(1234.5);
  });

  it('fetchWalletBalance: маржа из coin[].totalPositionIM/totalOrderIM, когда поля аккаунта пусты', async () => {
    // Bybit для UNIFIED шлёт IM внутри монет, а totalInitialMargin/available — пустыми («»).
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [{
            accountType: 'UNIFIED',
            totalEquity: '211.6',
            totalWalletBalance: '209.8',
            totalMarginBalance: '',
            totalAvailableBalance: '',
            totalPerpUPL: '1.8',
            totalInitialMargin: '',
            totalPositionInitialMargin: '',
            totalOrderInitialMargin: '',
            coin: [{
              coin: 'USDT', walletBalance: '209.8', equity: '211.6',
              availableToWithdraw: '', usdValue: '211.6',
              totalPositionIM: '38.5', totalOrderIM: '1.2',
            }],
          }],
        },
      }),
    })));
    const w = await fetchWalletBalance({ key: 'K', secret: 'S', testnet: false });
    expect(w.totalEquity).toBe(211.6);
    expect(w.totalInitialMargin).toBeCloseTo(39.7, 1); // 38.5 позиции + 1.2 ордера
    expect(w.totalPositionInitialMargin).toBeCloseTo(38.5, 1);
    expect(w.totalOrderInitialMargin).toBeCloseTo(1.2, 1);
    expect(w.totalAvailableBalance).toBeCloseTo(171.9, 1); // equity − маржа
    expect(w.coins[0]).toMatchObject({ positionIM: 38.5, orderIM: 1.2 });
  });

  it('fetchWalletBalance парсит маржу и нереализованный P&L', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [{
            accountType: 'UNIFIED',
            totalEquity: '1010',
            totalWalletBalance: '1000',
            totalMarginBalance: '10',
            totalAvailableBalance: '990',
            totalPerpUPL: '10',
            totalInitialMargin: '55',
            totalPositionInitialMargin: '50',
            totalOrderInitialMargin: '5',
            coin: [],
          }],
        },
      }),
    })));
    const w = await fetchWalletBalance({ key: 'K', secret: 'S', testnet: true });
    expect(w).toMatchObject({
      totalPerpUPL: 10,
      totalInitialMargin: 55,
      totalPositionInitialMargin: 50,
      totalOrderInitialMargin: 5,
      totalAvailableBalance: 990,
      totalEquity: 1010,
    });
  });

  it('credentials: без localStorage load → null, save/clear безопасны', () => {
    expect(loadCredentials()).toBeNull();
    saveCredentials({ key: 'K', secret: 'S', testnet: false });
    clearCredentials();
    expect(loadCredentials()).toBeNull();
  });

  it('session-режим: saveCredentials(..., false) не пишет в localStorage, persist=true вытесняет', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    // Без персиста: пусто в хранилище, но loadCredentials отдаёт сессионные.
    saveCredentials({ key: 'S1', secret: 'S1', testnet: true }, false);
    expect(hasStoredCredentials()).toBe(false);
    expect(loadCredentials()).toEqual({ key: 'S1', secret: 'S1', testnet: true });
    // Персист вытесняет сессионные.
    saveCredentials({ key: 'P1', secret: 'P1', testnet: false });
    expect(hasStoredCredentials()).toBe(true);
    expect(loadCredentials()).toEqual({ key: 'P1', secret: 'P1', testnet: false });
    clearCredentials();
    expect(loadCredentials()).toBeNull();
  });
});

describe('ключи из .env (локальный dev-сервер)', () => {
  it('parseDevCredentials: обрезает пробелы, testnet только при true', () => {
    expect(parseDevCredentials({ key: ' K ', secret: ' S ', testnet: true })).toEqual({ key: 'K', secret: 'S', testnet: true });
    expect(parseDevCredentials({ key: 'K', secret: 'S', testnet: 'yes' })).toEqual({ key: 'K', secret: 'S', testnet: false });
  });

  it('parseDevCredentials: без ключа/секрета или с пустыми — null', () => {
    expect(parseDevCredentials(undefined)).toBeNull();
    expect(parseDevCredentials(null)).toBeNull();
    expect(parseDevCredentials({})).toBeNull();
    expect(parseDevCredentials({ key: 'K' })).toBeNull();
    expect(parseDevCredentials({ key: '   ', secret: 'S' })).toBeNull();
    expect(parseDevCredentials({ key: 1, secret: 'S' })).toBeNull();
  });

  it('в тестах/сборке константы __DEV_BYBIT__ нет → devCredentials() null, localStorage главнее', () => {
    // Сборка и vitest не получают define из vite.config.ts — секреты туда не попадают.
    expect(devCredentials()).toBeNull();
    // В node-окружении localStorage нет: проверяем, что всё безопасно, и отдельно — с хранилищем.
    expect(hasStoredCredentials()).toBe(false);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(hasStoredCredentials()).toBe(false);
    saveCredentials({ key: 'K', secret: 'S', testnet: true });
    expect(hasStoredCredentials()).toBe(true);
    expect(loadCredentials()).toEqual({ key: 'K', secret: 'S', testnet: true });
    clearCredentials();
    expect(hasStoredCredentials()).toBe(false);
    expect(loadCredentials()).toBeNull();
  });
});