import { useCallback, useEffect, useState } from 'react';
import type { PaperPosition, SettleInfo } from '../lib/paper';

const KEY = 'paper:positions:v1';

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

/** Бумажные позиции в localStorage + синхронизация между вкладками. */
export function usePaperPositions() {
  const [positions, setPositions] = useState<PaperPosition[]>(load);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPositions(load());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((fn: (prev: PaperPosition[]) => PaperPosition[]) => {
    setPositions((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      save(next);
      return next;
    });
  }, []);

  const add = useCallback(
    (p: PaperPosition) => update((prev) => [p, ...prev]),
    [update],
  );

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

  /** Материализация авто-закрытий (стоп/TP3). Пишет только если есть изменения. */
  const settle = useCallback(
    (list: { id: string; info: SettleInfo }[]) => {
      if (list.length === 0) return;
      update((prev) => {
        let changed = false;
        const next = prev.map((p) => {
          const f = list.find((x) => x.id === p.id);
          if (f && p.status === 'open') {
            changed = true;
            return { ...p, status: 'closed' as const, ...f.info };
          }
          return p;
        });
        return changed ? next : prev;
      });
    },
    [update],
  );

  const remove = useCallback(
    (id: string) => update((prev) => prev.filter((p) => p.id !== id)),
    [update],
  );

  return { positions, add, closeManual, settle, remove };
}
