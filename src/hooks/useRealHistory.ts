import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiExecution } from '../api/privateApi';
import {
  loadRealHistory,
  mergeExecutions,
  realHistoryEventName,
  saveRealHistory,
  type RealTrade,
} from '../lib/realHistory';

/**
 * История реальных сделок в localStorage. Пишется исполнениями с биржи
 * (REST `/v5/execution/list` — первоначальное наполнение, приватный WS — живая лента),
 * дедупликация по execId. Как бумажный стор: storage-событие между вкладками,
 * CHANGED_EVENT внутри одной.
 */
export function useRealHistory() {
  const [trades, setTrades] = useState<RealTrade[]>(loadRealHistory);
  const ref = useRef<RealTrade[]>(trades);

  useEffect(() => {
    ref.current = trades;
  }, [trades]);

  useEffect(() => {
    const reload = () => setTrades(loadRealHistory());
    window.addEventListener('storage', reload);
    window.addEventListener(realHistoryEventName(), reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(realHistoryEventName(), reload);
    };
  }, []);

  /** Добавить новые исполнения (с дедупом). Возвращает true, если что-то добавилось. */
  const add = useCallback((items: ApiExecution[], limit = 500): boolean => {
    const merged = mergeExecutions(ref.current, items, limit);
    const same = merged.length === ref.current.length
      && merged.every((t, i) => t.execId === ref.current[i]?.execId);
    if (same) return false;
    ref.current = merged;
    setTrades(merged);
    saveRealHistory(merged);
    try {
      window.dispatchEvent(new Event(realHistoryEventName()));
    } catch { /* noop */ }
    return true;
  }, []);

  const reset = useCallback(() => {
    ref.current = [];
    setTrades([]);
    saveRealHistory([]);
    try {
      window.dispatchEvent(new Event(realHistoryEventName()));
    } catch { /* noop */ }
  }, []);

  return { trades, add, reset };
}