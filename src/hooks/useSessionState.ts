import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * useState с синхронизацией в sessionStorage: выбранные значения
 * переживают перезагрузку вкладки, но не засоряют постоянное хранилище.
 */
export function useSessionState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw);
        if (!validate || validate(parsed)) return parsed as T;
      }
    } catch {
      /* повреждённое значение — берём дефолт */
    }
    return initial;
  });

  const set: Dispatch<SetStateAction<T>> = (next) => {
    setValue((prev) => {
      const nv = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        sessionStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* приватный режим и т.п. — работаем без персиста */
      }
      return nv;
    });
  };

  return [value, set];
}
