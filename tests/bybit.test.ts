import { afterEach, describe, expect, it, vi } from 'vitest';
import { bybitTradeUrl, fetchKlines, fetchTickers, isCategory, isInterval } from '../src/api/bybit';

afterEach(() => {
  vi.unstubAllGlobals();
});

const okJson = (result: unknown) => ({ retCode: 0, retMsg: 'OK', result });

const mockFetch = (fn: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) => {
  vi.stubGlobal('fetch', vi.fn(fn));
};

describe('fetchKlines', () => {
  it('парсит сырые строки Bybit, сортирует по времени, отбрасывает close=0', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => okJson({
        list: [
          ['3000', '10', '11', '9', '10.5', '100', '1050'],
          ['1000', '10', '11', '9', '0', '100', '0'], // close 0 → отфильтрован
          ['2000', '10.5', '11.5', '9.5', '10', '100', '1000'],
        ],
      }),
    }));
    const candles = await fetchKlines('linear', 'BTCUSDT', '5', 200);
    expect(candles).toHaveLength(2);
    expect(candles[0].time).toBe(2000);
    expect(candles[1].time).toBe(3000);
    expect(candles[1].close).toBe(10.5);
    expect(candles[1].turnover).toBe(1050);
  });

  it('нечисловые значения → 0, но только close>0 проходит', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => okJson({ list: [['1000', 'zzz', '11', '9', '10', 'x', 'y']] }),
    }));
    const candles = await fetchKlines('linear', 'BTCUSDT', '5', 200);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 0, close: 10, volume: 0 });
  });

  it('limit клампится в 10..1000 и попадает в URL', async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => okJson({ list: [] }) };
    });
    await fetchKlines('spot', 'ETHUSDT', 'D', 5);
    expect(urls[0]).toContain('limit=10');
    await fetchKlines('spot', 'ETHUSDT', 'D', 5000);
    expect(urls[1]).toContain('limit=1000');
  });

  it('retCode != 0 → ошибка', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({ retCode: 10001, retMsg: 'bad symbol', result: {} }),
    }));
    await expect(fetchKlines('linear', 'XXX', '5', 200)).rejects.toThrow(/bad symbol/);
  });

  it('HTTP-ошибка → ошибка', async () => {
    mockFetch(async () => ({ ok: false, json: async () => ({}) }));
    await expect(fetchKlines('linear', 'BTCUSDT', '5', 200)).rejects.toThrow(/HTTP/);
  });

  it('при CORS/network-ошибке и наличии window переходит на proxy /bybit', async () => {
    vi.stubGlobal('window', {});
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      if (String(url).startsWith('https://api.bybit.com')) throw new Error('network fail');
      return { ok: true, json: async () => okJson({ list: [['1000', '10', '11', '9', '10', '1', '10']] }) };
    });
    const candles = await fetchKlines('linear', 'BTCUSDT', '5', 200);
    expect(candles).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api\.bybit\.com/);
    expect(urls[1]).toMatch(/^\/bybit\/v5\/market\/kline/);
  });

  it('без window network-ошибка пробрасывается (нет fallback в node)', async () => {
    mockFetch(async () => {
      throw new Error('network fail');
    });
    await expect(fetchKlines('linear', 'BTCUSDT', '5', 200)).rejects.toThrow(/network fail/);
  });
});

describe('fetchTickers', () => {
  it('нормализует тикеры: числа, пустой fundingRate → null, lastPrice 0 → исключён', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => okJson({
        list: [
          { symbol: 'BTCUSDT', lastPrice: '50000', price24hPcnt: '0.05', highPrice24h: '51000', lowPrice24h: '49000', volume24h: '1', turnover24h: '50000', fundingRate: '0.0001', openInterest: '100' },
          { symbol: 'BAD', lastPrice: 'abc', price24hPcnt: '', highPrice24h: '', lowPrice24h: '', volume24h: '', turnover24h: '', fundingRate: '', openInterest: '' },
          { symbol: 'NOFR', lastPrice: '1', price24hPcnt: '0', highPrice24h: '1', lowPrice24h: '1', volume24h: '0', turnover24h: '0', fundingRate: '', openInterest: '' },
        ],
      }),
    }));
    const ticks = await fetchTickers('linear');
    expect(ticks.map((t) => t.symbol)).toEqual(['BTCUSDT', 'NOFR']);
    expect(ticks[0].fundingRate).toBe(0.0001);
    expect(ticks[0].openInterest).toBe(100);
    expect(ticks[1].fundingRate).toBeNull();
  });
});

describe('bybitTradeUrl', () => {
  it('linear → терминал USDT', () => {
    expect(bybitTradeUrl('linear', 'BTCUSDT')).toBe('https://www.bybit.com/trade/usdt/BTCUSDT');
  });

  it('inverse → терминал inverse', () => {
    expect(bybitTradeUrl('inverse', 'BTCUSD')).toBe('https://www.bybit.com/trade/inverse/BTCUSD');
  });

  it('spot → через базовую монету и коут', () => {
    expect(bybitTradeUrl('spot', 'BTCUSDT')).toBe('https://www.bybit.com/en/trade/spot/BTC/BTCUSDT');
    expect(bybitTradeUrl('spot', 'ETHUSDC')).toBe('https://www.bybit.com/en/trade/spot/ETH/ETHUSDC');
  });

  it('spot без известного коута → null', () => {
    expect(bybitTradeUrl('spot', 'FOOXYZ')).toBeNull();
    expect(bybitTradeUrl('spot', 'USDT')).toBeNull(); // символ = коут
  });

  it('option → null', () => {
    expect(bybitTradeUrl('option', 'BTC-29DEC25-100000-C')).toBeNull();
  });
});

describe('валидаторы', () => {
  it('isCategory', () => {
    expect(isCategory('linear')).toBe(true);
    expect(isCategory('spot')).toBe(true);
    expect(isCategory('nope')).toBe(false);
    expect(isCategory(5)).toBe(false);
  });

  it('isInterval', () => {
    expect(isInterval('5')).toBe(true);
    expect(isInterval('D')).toBe(true);
    expect(isInterval('7')).toBe(false);
    expect(isInterval(5)).toBe(false);
  });
});