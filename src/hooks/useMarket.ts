import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchKlines, fetchTickers, type Category, type Interval } from '../api/bybit';
import { effectiveCycleMs, perCycleFor, planRefresh } from '../lib/klinePlan';

/** Тикеры категории, топ по turnover. */
export function useTickers(category: Category, refreshMs: number | false = 60_000) {
  return useQuery({
    queryKey: ['tickers', category],
    queryFn: () => fetchTickers(category),
    staleTime: 30_000,
    refetchInterval: refreshMs,
    // Тикеров на всю категорию ровно один запрос — почему бы и не освежать при фокусе.
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export interface KlineResult {
  symbol: string;
  candles: ReturnType<typeof fetchKlines> extends Promise<infer T> ? T : never;
  error: string | null;
  loading: boolean;
  /** Идёт перезапрос (в т.ч. ручной refetchQueries) — не только первичная загрузка. */
  fetching: boolean;
}

export interface KlineOpts {
  /** Ждать данные тикеров, прежде чем грузить свечи. */
  enabled?: boolean;
  /** Период цикла обновления, мс; false — не обновлять (данные из кэша запроса). */
  refreshMs?: number | false;
  /** Бюджет символов на цикл; false — обновлять всю выборку каждый цикл. */
  perCycle?: number | false;
}

/** Счётчик циклов обновления: тик на каждом интервале, ноль при остановленном цикле. */
function useCycle(cycleMs: number | false): number {
  const [state, setState] = useState({ ms: cycleMs, n: 0 });
  // Смена интервала обнуляет счётчик — это поправка состояния на этапе рендера.
  if (state.ms !== cycleMs) setState({ ms: cycleMs, n: 0 });
  const cycle = state.ms === cycleMs ? state.n : 0;
  useEffect(() => {
    if (!cycleMs) return;
    let id = 0;
    const schedule = () => {
      id = window.setTimeout(() => {
        setState((s) => ({ ms: cycleMs, n: s.n + 1 }));
        schedule();
      }, cycleMs);
    };
    schedule();
    return () => window.clearTimeout(id);
  }, [cycleMs]);
  return cycle;
}

/**
 * Батч-загрузка kline для списка символов (только выбранный интервал).
 *
 * Запросов к бирже в цикле ровно `perCycle`: первые (самые ликвидные) символы
 * обновляем каждый цикл, остальные — по круговой очереди. Без этого 200 символов
 * на автообновлении 60 с давали 200 запросов в минуту, и биржа отвечала 429.
 *
 * Первый прогон грузит выборку целиком — иначе таблица была бы пустой. Дальше
 * запросы не тикают сами (`refetchInterval: false`), их обновляет тик цикла:
 * он перезапрашивает ровно свой срез. Так не зависит от того, в каком порядке
 * доехали первые ответы, и не гоняется с моментом собственной загрузки запроса.
 */
export function useKlines(
  category: Category,
  symbols: string[],
  interval: Interval,
  limit = 200,
  opts: KlineOpts = {},
): KlineResult[] {
  const { enabled = true } = opts;
  const qc = useQueryClient();
  const cycleMs = effectiveCycleMs(interval, opts.refreshMs ?? false);
  const cycle = useCycle(cycleMs);

  const perCycle = useMemo(() => {
    if (opts.perCycle === false) return 0; // без ограничения
    if (typeof opts.perCycle === 'number') return opts.perCycle;
    return perCycleFor(symbols.length, cycleMs || 75_000);
  }, [opts.perCycle, symbols.length, cycleMs]);

  // Срез этого цикла: символы, которые обновляем сейчас.
  const dueSymbols = useMemo(() => {
    if (perCycle <= 0) return symbols;
    return planRefresh(symbols.length, cycle, { perCycle })
      .map((i) => symbols[i])
      .filter((s): s is string => s != null);
  }, [perCycle, cycle, symbols]);

  const queries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ['kline', category, symbol, interval, limit],
      queryFn: () => fetchKlines(category, symbol, interval, limit),
      staleTime: cycleMs || 60_000,
      // Обновляет тик цикла ниже. Ни автоинтервала, ни рефетча по фокусу/монтированию:
      // возврат на вкладку не должен бить по всей выборке сразу.
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
      enabled,
    })),
  });

  // Тик цикла обновляет свой срез; смена списка символов меняет набор запросов
  // сам (mount), а рефетч дёргать не должна.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled || cycle === 0 || !cycleMs) return;
    // Пока первый проход грузит выборку, не мешаем ему: у символов без данных запрос уже идёт.
    for (const s of dueSymbols) {
      if (qc.getQueryData(['kline', category, s, interval, limit]) == null) continue;
      void qc.refetchQueries({ queryKey: ['kline', category, s] });
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);

  return queries.map((q, i) => ({
    symbol: symbols[i],
    candles: (q.data ?? []) as KlineResult['candles'],
    error: q.error ? String((q.error as Error).message ?? q.error) : null,
    loading: q.isPending,
    fetching: q.isFetching,
  }));
}
