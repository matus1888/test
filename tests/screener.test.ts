import { describe, expect, it } from 'vitest';
import { buildRows, filterByConfidence, sortRows, COLUMNS, type Row } from '../src/lib/screener';
import type { Category, Interval, Ticker } from '../src/api/bybit';
import { flatSeries, upSeries } from './helpers/candles';

const ticker = (symbol: string, over: Partial<Ticker> = {}): Ticker => ({
  symbol,
  lastPrice: 10,
  price24hPcnt: 0.01,
  highPrice24h: 11,
  lowPrice24h: 9,
  volume24h: 1000,
  turnover24h: 10_000,
  fundingRate: 0.0001,
  openInterest: null,
  ...over,
});

const kline = (candles: ReturnType<typeof upSeries>, over: { error?: string | null; loading?: boolean } = {}) => ({
  candles,
  error: over.error ?? null,
  loading: over.loading ?? false,
});

const CAT: Category = 'linear';
const IV: Interval = '5';

describe('buildRows', () => {
  it('строит ряды из тикеров и свечей: метрики, направление, уверенность', () => {
    const rows = buildRows(
      ['AAUSDT', 'BBUSDT'],
      [ticker('AAUSDT'), ticker('BBUSDT')],
      [kline(upSeries(200)), kline(flatSeries(200))],
      CAT,
      IV,
    );
    expect(rows).toHaveLength(2);

    const aa = rows[0];
    expect(aa.price).toBe(10);
    expect(aa.m).not.toBeNull();
    expect(aa.direction).toBe('long');
    expect(aa.confidence).toBeGreaterThanOrEqual(8);
    expect(aa.klineError).toBeNull();
    expect(aa.klineLoading).toBe(false);
  });

  it('wait-сетап: направление wait, уверенность null (в таблице «—»)', () => {
    const rows = buildRows(['FLAT'], [ticker('FLAT')], [kline(flatSeries(200))], CAT, IV);
    expect(rows[0].direction).toBe('wait');
    expect(rows[0].confidence).toBeNull();
  });

  it('меньше 10 свечей → метрики и план null', () => {
    const rows = buildRows(['SMALL'], [ticker('SMALL')], [kline(upSeries(5))], CAT, IV);
    expect(rows[0].m).toBeNull();
    expect(rows[0].direction).toBeNull();
    expect(rows[0].confidence).toBeNull();
  });

  it('10–54 свечи → метрики есть, плана нет (порог плана 55)', () => {
    const rows = buildRows(['MID'], [ticker('MID')], [kline(upSeries(30))], CAT, IV);
    expect(rows[0].m).not.toBeNull();
    expect(rows[0].direction).toBeNull();
    expect(rows[0].confidence).toBeNull();
  });

  it('ошибка свечей пробрасывается', () => {
    const rows = buildRows(['ERR'], [ticker('ERR')], [{ candles: [], error: 'HTTP 0', loading: false }], CAT, IV);
    expect(rows[0].klineError).toBe('HTTP 0');
  });

  it('fundingRate из тикера; null при отсутствии', () => {
    const rows = buildRows(
      ['N', 'NULL'],
      [ticker('N'), ticker('NULL', { fundingRate: null })],
      [kline(upSeries(200)), kline(upSeries(200))],
      CAT,
      IV,
    );
    expect(rows[0].fundingRate).toBe(0.0001);
    expect(rows[1].fundingRate).toBeNull();
  });
});

describe('sortRows', () => {
  const rows: Row[] = [
    { symbol: 'B', price: 5, turnover: 50, fundingRate: null, m: null, direction: null, confidence: null, klineError: null, klineLoading: false },
    { symbol: 'A', price: 10, turnover: 100, fundingRate: null, m: null, direction: null, confidence: null, klineError: null, klineLoading: false },
    { symbol: 'C', price: 7, turnover: 70, fundingRate: null, m: null, direction: 'long', confidence: 90, klineError: null, klineLoading: false },
  ];

  it('сортировка по символам: asc и desc', () => {
    expect(sortRows(rows, 'symbol', 1).map((r) => r.symbol)).toEqual(['A', 'B', 'C']);
    expect(sortRows(rows, 'symbol', -1).map((r) => r.symbol)).toEqual(['C', 'B', 'A']);
  });

  it('числовая сортировка по цене', () => {
    expect(sortRows(rows, 'price', 1).map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
    expect(sortRows(rows, 'price', -1).map((r) => r.symbol)).toEqual(['A', 'C', 'B']);
  });

  it('не меняет исходный массив', () => {
    const before = rows.map((r) => r.symbol);
    sortRows(rows, 'price', 1);
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });

  it('строки без данных уходят вниз (отсутствующие значения = -Infinity)', () => {
    const withNulls: Row[] = [
      { symbol: 'X', price: 0, turnover: 0, fundingRate: null, m: null, direction: null, confidence: null, klineError: null, klineLoading: false },
      { symbol: 'Y', price: 0, turnover: 0, fundingRate: null, m: null, direction: 'long', confidence: 80, klineError: null, klineLoading: false },
    ];
    const sorted = sortRows(withNulls, 'confidence', -1);
    expect(sorted[0].symbol).toBe('Y');
  });

  it('NaN в метриках не роняет сортировку (защита от регресса)', () => {
    const bad: Row = {
      symbol: 'NAN', price: 0, turnover: 0, fundingRate: null,
      m: { score: NaN } as Row['m'], direction: null, confidence: null, klineError: null, klineLoading: false,
    };
    expect(() => sortRows([bad, rows[0], rows[1]], 'score', -1)).not.toThrow();
  });
});

describe('filterByConfidence', () => {
  const rows: Row[] = [
    { symbol: 'L', price: 1, turnover: 1, fundingRate: null, m: null, direction: 'long', confidence: 90, klineError: null, klineLoading: false },
    { symbol: 'S', price: 1, turnover: 1, fundingRate: null, m: null, direction: 'short', confidence: 82, klineError: null, klineLoading: false },
    { symbol: 'W', price: 1, turnover: 1, fundingRate: null, m: null, direction: 'wait', confidence: null, klineError: null, klineLoading: false },
    { symbol: 'NB', price: 1, turnover: 1, fundingRate: null, m: null, direction: 'long', confidence: 60, klineError: null, klineLoading: false },
  ];

  it('minConf=0 → без фильтра', () => {
    expect(filterByConfidence(rows, 0)).toHaveLength(4);
  });

  it('отсекает wait и уверенность ниже порога; порог включается (>=)', () => {
    const filtered = filterByConfidence(rows, 82);
    expect(filtered.map((r) => r.symbol)).toEqual(['L', 'S']);
  });

  it('порог 90 оставляет только L', () => {
    expect(filterByConfidence(rows, 90).map((r) => r.symbol)).toEqual(['L']);
  });
});

describe('COLUMNS', () => {
  it('ключи колонок соответствуют SortKey', () => {
    expect(COLUMNS.length).toBeGreaterThan(0);
    for (const c of COLUMNS) expect(c.key.length).toBeGreaterThan(0);
  });
});