// Живые цены из WebSocket Bybit: общий стор на вкладку + слияние с REST-тикерами.
//
// Тикер приходит раз в 100 мс на символ, поэтому наружу отдаём не каждое сообщение,
// а «пакет» раз в FLUSH_MS: рендер таблицы портфеля от этого не дорожает в разы,
// а глаз всё равно не видит обновление чаще кадра.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { publicWs } from '../api/ws';
import type { Category } from '../api/bybit';

export type WsFeed = 'off' | 'connecting' | 'live' | 'down';

export interface LiveTicker {
  symbol: string;
  lastPrice: number;
  markPrice: number | null;
  price24hPcnt: number;
  turnover24h: number;
  ts: number;
}

/** Как часто обновляем интерфейс при потоке сообщений. */
export const FLUSH_MS = 400;

const cache = new Map<string, LiveTicker>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

const keyOf = (category: Category, symbol: string) => `${category}:${symbol}`;

export function tickerKey(category: Category, symbol: string): string {
  return keyOf(category, symbol);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const optional = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Разбор кадра `tickers.{symbol}` (linear/inverse delta-поля меняются частично). */
export function parseTicker(data: unknown): LiveTicker | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const symbol = typeof d.symbol === 'string' ? d.symbol : '';
  const lastPrice = num(d.lastPrice);
  if (!symbol || lastPrice <= 0) return null;
  return {
    symbol,
    lastPrice,
    markPrice: optional(d.markPrice),
    price24hPcnt: num(d.price24hPcnt),
    turnover24h: num(d.turnover24h),
    ts: Date.now(),
  };
}

/** Положить значение в стор (публично для тестов и для подстановки из приватных кадров). */
export function putTicker(category: Category, ticker: LiveTicker): void {
  cache.set(keyOf(category, ticker.symbol), ticker);
  if (flushTimer == null) {
    flushTimer = setTimeout(flush, FLUSH_MS);
  }
}

function flush(): void {
  flushTimer = null;
  version += 1;
  for (const l of listeners) l();
}

/** Последняя цена по символу (без подписки) — для расчётов вне React. */
export function tickerPrice(category: Category, symbol: string): number | null {
  return cache.get(keyOf(category, symbol))?.lastPrice ?? null;
}

export function tickerOf(category: Category, symbol: string): LiveTicker | undefined {
  return cache.get(keyOf(category, symbol));
}

/** Только для тестов. */
export function __resetTickerCache(): void {
  cache.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  version = 0;
}

function subscribeStore(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

const getVersion = () => version;

/**
 * Подписка на тикеры символов. Возвращает карту `категория:символ` → цена.
 * Сокет поднимается только когда кто-то реально смотрит на эти символы.
 */
export function useWsPrices(groups: { category: Category; symbols: string[] }[]): Map<string, number> {
  const signature = useMemo(
    () => groups.map((g) => `${g.category}:${g.symbols.join(',')}`).join('|'),
    [groups],
  );

  const versionNow = useSyncExternalStore(subscribeStore, getVersion, getVersion);

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const g of groups) {
      const conn = publicWs(g.category);
      for (const symbol of g.symbols) {
        cleanups.push(
          conn.subscribe(`tickers.${symbol}`, (data) => {
            const t = parseTicker(data);
            if (t) putTicker(g.category, t);
          }),
        );
      }
    }
    return () => {
      for (const c of cleanups) c();
    };
    // signature вместо groups: массивы пересоздаются на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) {
      for (const s of g.symbols) {
        const t = cache.get(keyOf(g.category, s));
        if (t) m.set(keyOf(g.category, s), t.lastPrice);
      }
    }
    // versionNow — сигнал «стор обновился», он же входит в зависимости.
    void versionNow;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, versionNow]);
}

/** Последние 24 ч/оборот по символам (для показателей и фильтров), из сокета. */
export function useWsTickers(groups: { category: Category; symbols: string[] }[]): Map<string, LiveTicker> {
  const signature = useMemo(
    () => groups.map((g) => `${g.category}:${g.symbols.join(',')}`).join('|'),
    [groups],
  );
  const versionNow = useSyncExternalStore(subscribeStore, getVersion, getVersion);
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const g of groups) {
      const conn = publicWs(g.category);
      for (const symbol of g.symbols) {
        cleanups.push(
          conn.subscribe(`tickers.${symbol}`, (data) => {
            const t = parseTicker(data);
            if (t) putTicker(g.category, t);
          }),
        );
      }
    }
    return () => {
      for (const c of cleanups) c();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return useMemo(() => {
    const m = new Map<string, LiveTicker>();
    for (const g of groups) {
      for (const s of g.symbols) {
        const t = cache.get(keyOf(g.category, s));
        if (t) m.set(keyOf(g.category, s), t);
      }
    }
    void versionNow;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, versionNow]);
}

/** Цена из стора, иначе `fallback` — для мест, где рендер без сокета не должен ломаться. */
export function usePrice(category: Category, symbol: string, fallback: number): number {
  const groups = useMemo(() => [{ category, symbols: [symbol] }], [category, symbol]);
  const prices = useWsPrices(groups);
  return prices.get(keyOf(category, symbol)) ?? fallback;
}

/**
 * Состояние публичного сокета для метки в интерфейсе. Соединение поднимается
 * только когда на его темы есть подписчики, поэтому «live» означает и данные.
 */
export function usePublicWsLive(categories: Category[]): WsFeed {
  const sig = categories.join('|');
  const [state, setState] = useState<WsFeed>('off');
  useEffect(() => {
    const list = categories;
    if (list.length === 0) {
      setState('off');
      return;
    }
    const conns = list.map((c) => publicWs(c));
    const read = () => {
      // Для публичного потока «open» означает и готовность: подписок до auth нет.
      if (conns.some((c) => c.status === 'open')) setState('live');
      else if (conns.some((c) => c.status === 'connecting')) setState('connecting');
      else setState('down');
    };
    const offs = conns.map((c) => c.onStatus(read));
    read();
    return () => {
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return state;
}
