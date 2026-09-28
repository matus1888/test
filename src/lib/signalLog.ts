import type { Category, Interval } from '../api/bybit';
import { priorityOf, type Row } from './screener';

/**
 * Журнал сигналов: снимки того, что скринер показывал в каждый прогон.
 * Нужен, чтобы можно было ответить «из N сетапов, показанных за неделю, я взял M —
 * как они отработали». Пишется при каждом завершённом обновлении скринера.
 */

export interface SignalSnapshot {
  /** Время снимка, ms. */
  ts: number;
  category: Category;
  interval: Interval;
  /** Сетапы в порядке приоритета (топ-20 по priorityOf). */
  setups: { symbol: string; direction: 'long' | 'short'; confidence: number; priority: number }[];
}

const KEY = 'paper:signals:v1';
const MAX_SNAPSHOTS = 40; // по одному на прогон — примерно неделя-две при автообновлении
const MAX_SETUPS_PER_SNAPSHOT = 20;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage есть только в браузере; в node-тестах работаем в памяти. */
const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);

function load(): SignalSnapshot[] {
  try {
    const s = storage();
    if (!s) return [];
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s): s is SignalSnapshot =>
        typeof s === 'object' && s !== null && typeof (s as { ts?: unknown }).ts === 'number',
    );
  } catch {
    return [];
  }
}

function save(list: SignalSnapshot[]): void {
  try {
    const s = storage();
    if (!s) return;
    s.setItem(KEY, JSON.stringify(list));
  } catch {
    /* переполнено — работаем в памяти */
  }
}

/**
 * Записать снимок текущих сетапов. Дедупликация: если за последние 60 с уже был
 * снят снимок с тем же набором символов, новый не пишем — иначе автообновление
 * замусорит журнал одинаковыми кадрами.
 */
export function recordSignalSnapshot(
  rows: Row[],
  category: Category,
  interval: Interval,
  now = Date.now(),
): SignalSnapshot[] {
  const setups = rows
    .filter((r): r is Row & { direction: 'long' | 'short' } => r.direction === 'long' || r.direction === 'short')
    .sort((a, b) => priorityOf(b) - priorityOf(a))
    .slice(0, MAX_SETUPS_PER_SNAPSHOT)
    .map((r) => ({
      symbol: r.symbol,
      direction: r.direction as 'long' | 'short',
      confidence: r.confidence ?? 0,
      priority: priorityOf(r),
    }));
  if (setups.length === 0) return load();

  const list = load();
  const last = list[0];
  if (last && now - last.ts < 60_000 && last.setups.length === setups.length
    && last.setups.every((s, i) => s.symbol === setups[i]?.symbol)) {
    return list; // тот же кадр, что и минуту назад — не дублируем
  }

  const next = [{ ts: now, category, interval, setups }, ...list]
    .filter((s) => now - s.ts < TTL_MS)
    .slice(0, MAX_SNAPSHOTS);
  save(next);
  return next;
}

/** Текущий журнал (свежие первыми). */
export function loadSignalLog(): SignalSnapshot[] {
  return load().filter((s) => Date.now() - s.ts < TTL_MS);
}

/** Очистить журнал (кнопка в интерфейсе). */
export function clearSignalLog(): void {
  try {
    const s = storage();
    if (s) s.removeItem(KEY);
  } catch {
    /* noop */
  }
}