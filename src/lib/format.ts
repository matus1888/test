/** Форматирование чисел для UI. */

export const fmt = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
};

export const fmtPct = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
};

export const fmtCompact = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
};
