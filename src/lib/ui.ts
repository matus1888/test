import type { Direction } from './tradePlan';

/** CSS-класс для раскраски чисел: рост/падение. */
export function numCls(v: number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

/** Русская подпись направления сетапа. */
export function setupText(d: Direction | null): string {
  if (d === 'long') return 'ЛОНГ';
  if (d === 'short') return 'ШОРТ';
  return '—';
}

/** CSS-класс для направления сетапа. */
export function setupCls(d: Direction | null): string {
  if (d === 'long') return 'setup-long';
  if (d === 'short') return 'setup-short';
  return 'setup-wait';
}
