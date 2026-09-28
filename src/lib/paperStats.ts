import type { PaperPosition } from './paper';
import { totalPnlOf } from './paper';

/** Срез по группе закрытых позиций: сколько, сколько прибыльных, суммарный R и $. */
export interface SliceRow {
  label: string;
  n: number;
  wins: number;
  sumR: number;
  sumNet: number;
}

/** Группировка по бакетам, чтобы цифры были читаемыми, а не поштучными. */
export const confBucket = (c: number): string => (c < 60 ? '<60' : c < 75 ? '60-75' : c < 85 ? '75-85' : c < 92 ? '85-92' : '>=92');

/** ATR% ≈ (|вход − стоп| / 1.8) / вход — как в торговом плане. */
export const atrPctOf = (p: Pick<PaperPosition, 'entryPrice' | 'stop'>): number => {
  const atr = Math.abs(p.entryPrice - p.stop) / 1.8;
  return p.entryPrice > 0 ? (atr / p.entryPrice) * 100 : 0;
};
export const atrBucket = (pct: number): string => (pct < 0.5 ? '<0.5%' : pct < 1 ? '0.5-1%' : pct < 2 ? '1-2%' : '>=2%');

export interface ClosedStats {
  byDirection: SliceRow[];
  byOutcome: SliceRow[];
  byConf: SliceRow[];
  byAtr: SliceRow[];
  byInterval: SliceRow[];
  /** Точки кривой доходности по времени закрытия (незакрытые не входят). */
  equity: { time: number; cum: number }[];
}

const empty = (label: string): SliceRow => ({ label, n: 0, wins: 0, sumR: 0, sumNet: 0 });

function push(m: Map<string, SliceRow>, label: string, net: number, netR: number, win: boolean): void {
  const r = m.get(label) ?? empty(label);
  r.n += 1;
  r.sumNet += net;
  r.sumR += netR;
  if (win) r.wins += 1;
  m.set(label, r);
}

const outcomeLabel = (p: PaperPosition): string => {
  if (p.closeReason === 'manual') return 'вручную';
  const legs = (p.legs ?? []).map((l) => l.reason);
  if (legs.length > 0) return `частично ${legs.join('+')}`;
  return p.closeReason ?? 'открыта';
};

/**
 * Статистика по закрытым позициям: срезы, по которым видно, что реально
 * зарабатывает. Все функции — чистые, чтобы их можно было тестировать.
 */
export function closedStats(closed: PaperPosition[]): ClosedStats | null {
  if (closed.length === 0) return null;
  const byDirection = new Map<string, SliceRow>();
  const byOutcome = new Map<string, SliceRow>();
  const byConf = new Map<string, SliceRow>();
  const byAtr = new Map<string, SliceRow>();
  const byInterval = new Map<string, SliceRow>();

  const equity: { time: number; cum: number }[] = [];
  let cum = 0;
  const closedSorted = [...closed]
    .filter((p) => Number.isFinite(p.closedAt))
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  for (const p of closedSorted) {
    const t = totalPnlOf(p, p.closePrice ?? p.entryPrice);
    const win = t.net > 0;
    push(byDirection, p.direction, t.net, t.netR, win);
    push(byOutcome, outcomeLabel(p), t.net, t.netR, win);
    push(byConf, confBucket(p.confidence), t.net, t.netR, win);
    push(byAtr, atrBucket(atrPctOf(p)), t.net, t.netR, win);
    push(byInterval, p.interval, t.net, t.netR, win);
    if (Number.isFinite(p.closedAt)) {
      cum += t.net;
      equity.push({ time: p.closedAt as number, cum });
    }
  }

  const rows = (m: Map<string, SliceRow>): SliceRow[] =>
    [...m.values()].sort((a, b) => b.n - a.n || b.sumR - a.sumR);

  return {
    byDirection: rows(byDirection),
    byOutcome: rows(byOutcome),
    byConf: rows(byConf),
    byAtr: rows(byAtr),
    byInterval: rows(byInterval),
    equity,
  };
}

/** Общие числа закрытых для заголовка над срезами. */
export function closedSummary(closed: PaperPosition[]): { n: number; wins: number; sumNet: number; winratePct: number | null } {
  let sumNet = 0;
  let wins = 0;
  for (const p of closed) {
    const net = totalPnlOf(p, p.closePrice ?? p.entryPrice).net;
    sumNet += net;
    if (net > 0) wins += 1;
  }
  return {
    n: closed.length,
    wins,
    sumNet,
    winratePct: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
  };
}