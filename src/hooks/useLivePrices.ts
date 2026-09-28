import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchTickers, type Category } from '../api/bybit';
import { useWsPrices } from '../lib/tickerStore';

/**
 * Живые цены тикеров. Ключ карты — `${category}:${symbol}`.
 *
 * Основной источник — WebSocket (`tickers.{symbol}`, 100 мс), REST-опрос оставлен
 * как страховка: если сокет не поднялся (сеть, регион, спящая вкладка), цена всё
 * равно обновится, просто раз в минуту.
 */
export function useLivePrices(groups: { category: Category; symbols: string[] }[]): Map<string, number> {
  const queries = useQueries({
    queries: groups.map((g) => ({
      queryKey: ['tickers', g.category],
      queryFn: () => fetchTickers(g.category),
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: 1,
    })),
  });
  const ws = useWsPrices(groups);
  return useMemo(() => {
    const map = new Map<string, number>();
    groups.forEach((g, i) => {
      for (const t of queries[i]?.data ?? []) map.set(`${g.category}:${t.symbol}`, t.lastPrice);
    });
    // Сокет поверх REST: он свежее, а REST заполняет карту до первого кадра сокета.
    for (const [k, v] of ws) map.set(k, v);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries, ws]);
}

/** Группировка позиций по категориям для батч-запросов тикеров и подписок сокета. */
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
