import { useCallback, useEffect, useRef, useState } from 'react';
import { applySettle, canOpenPosition, closeAllPositions, type DraftKey, type PaperPosition, type SettleInfo } from '../lib/paper';

const KEY = 'paper:positions:v1';
// Событие для оповещения экземпляров хука в ЭТОЙ вкладке: нативный `storage`-event
// срабатывает только между вкладками, поэтому без него PaperHeader и страницы
// расходились бы до перезагрузки.
const CHANGED_EVENT = 'paper:positions:changed';

function load(): PaperPosition[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is PaperPosition =>
        typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string',
    );
  } catch {
    return [];
  }
}

function save(list: PaperPosition[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* переполнено/приватный режим — работаем в памяти */
  }
}

function emitChanged(): void {
  try {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

/** Бумажные позиции в localStorage + синхронизация между вкладками и компонентами одной вкладки. */
export function usePaperPositions() {
  const [positions, setPositions] = useState<PaperPosition[]>(load);
  // Актуальный список для синхронных проверок без ожидания пере-рендера.
  const positionsRef = useRef<PaperPosition[]>(positions);

  useEffect(() => {
    const reload = () => setPositions(load());
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGED_EVENT, reload);
    };
  }, []);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  const update = useCallback((fn: (prev: PaperPosition[]) => PaperPosition[]) => {
    const next = fn(positionsRef.current);
    if (next === positionsRef.current) return;
    positionsRef.current = next;
    setPositions(next);
    save(next);
    emitChanged();
  }, []);

  /**
   * Открытие позиции. Проверяет дубли/лимиты по самому свежему списку (не из render-closure),
   * поэтому двойной клик по кнопке не создаст два одинаковых входа. Возвращает false,
   * если вход заблокирован.
   */
  const add = useCallback((p: PaperPosition): boolean => {
    const draft: DraftKey = {
      symbol: p.symbol,
      category: p.category,
      interval: p.interval,
      direction: p.direction,
    };
    if (canOpenPosition(positionsRef.current, draft)) return false;
    update((prev) => [p, ...prev]);
    return true;
  }, [update]);

  const closeManual = useCallback(
    (id: string, price: number, time: number) =>
      update((prev) =>
        prev.map((p) =>
          p.id === id && p.status === 'open'
            ? { ...p, status: 'closed' as const, closeReason: 'manual' as const, closePrice: price, closedAt: time }
            : p,
        ),
      ),
    [update],
  );

  /** Закрыть все открытые позиции по текущим ценам (одна запись в localStorage). */
  const closeAll = useCallback(
    (priceOf: (p: PaperPosition) => number) =>
      update((prev) => closeAllPositions(prev, priceOf)),
    [update],
  );

  /** Материализация авто-закрытий и частичных выходов. Пишет только если есть изменения. */
  const settle = useCallback(
    (list: { id: string; info: SettleInfo }[]) => {
      if (list.length === 0) return;
      update((prev) => applySettle(prev, list));
    },
    [update],
  );

  const remove = useCallback(
    (id: string) => update((prev) => prev.filter((p) => p.id !== id)),
    [update],
  );

  return { positions, add, closeManual, closeAll, settle, remove };
}