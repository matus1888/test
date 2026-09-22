import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchTickers, type Category } from '../api/bybit';

/** Живые цены тикеров по категориям. Ключ карты — `${category}:${symbol}`. */
export function useLivePrices(groups: { category: Category; symbols: string[] }[]): Map<string, number> {
  const queries = useQueries({
    queries: groups.map((g) => ({
      queryKey: ['tickers', g.category],
      queryFn: () => fetchTickers(g.category),
      staleTime: 30_000,
      refetchInterval: 30_000,
      retry: 1,
    })),
  });
  return useMemo(() => {
    const map = new Map<string, number>();
    groups.forEach((g, i) => {
      for (const t of queries[i]?.data ?? []) map.set(`${g.category}:${t.symbol}`, t.lastPrice);
    }
    );
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries]);
}

/** Группировка позиций по категориям для батч-запросов тикеров. */
export function groupByCategory(items: { category: Category; symbol: string }[]): {
  category: Category;
  symbols: string[];
}[] {
  const m = new Map<Category, Set<string>>();
  for (const it of items) {
    if (!m.has(it.category)) m.set(it.category, new Set());
    m.get(it.category)!.add(it.symbol);
  }
  return [...m.entries()].map(([category, set]) => ({ category, symbols: [...set] }));
}
