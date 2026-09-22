import { useQueries, useQuery } from '@tanstack/react-query';
import { fetchKlines, fetchTickers, type Category, type Interval } from '../api/bybit';

/** Тикеры категории, топ по turnover. */
export function useTickers(category: Category, refreshMs: number | false = 60_000) {
  return useQuery({
    queryKey: ['tickers', category],
    queryFn: () => fetchTickers(category),
    staleTime: 15_000,
    refetchInterval: refreshMs,
    retry: 2,
  });
}

export interface KlineResult {
  symbol: string;
  candles: ReturnType<typeof fetchKlines> extends Promise<infer T> ? T : never;
  error: string | null;
  loading: boolean;
}

/** Батч-загрузка kline для списка символов (только выбранный интервал). */
export function useKlines(
  category: Category,
  symbols: string[],
  interval: Interval,
  limit = 200,
  enabled = true,
  refreshMs: number | false = 120_000,
): KlineResult[] {
  const queries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ['kline', category, symbol, interval, limit],
      queryFn: () => fetchKlines(category, symbol, interval, limit),
      staleTime: 30_000,
      refetchInterval: refreshMs,
      retry: 1,
      enabled,
    })),
  });
  return queries.map((q, i) => ({
    symbol: symbols[i],
    candles: (q.data ?? []) as KlineResult['candles'],
    error: q.error ? String((q.error as Error).message ?? q.error) : null,
    loading: q.isPending,
  }));
}
