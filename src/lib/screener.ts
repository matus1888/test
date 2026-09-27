import type { Candle, Category, Interval, Ticker } from '../api/bybit';
import { computeMetrics, type SymbolMetrics } from './metrics';
import { buildTradePlan, type Direction, type TradePlan } from './tradePlan';

export type SortKey =
  | 'symbol' | 'price' | 'turnover' | 'setup' | 'confidence' | 'priority'
  | 'volatilityRange' | 'volatilityStd' | 'atrPct' | 'changePct'
  | 'momentumPct' | 'trendSlopePct' | 'rsi' | 'volumeRatio' | 'score' | 'fundingRate';

export const COLUMNS: { key: SortKey; label: string; gloss: string }[] = [
  { key: 'symbol', label: 'Символ', gloss: 'symbol' },
  { key: 'price', label: 'Цена', gloss: 'price' },
  { key: 'turnover', label: 'Оборот 24ч', gloss: 'turnover' },
  { key: 'setup', label: 'Сетап', gloss: 'direction' },
  { key: 'confidence', label: 'Увер. %', gloss: 'confidence' },
  { key: 'priority', label: 'Приоритет', gloss: 'priority' },
  { key: 'volatilityRange', label: 'Волат. %', gloss: 'volatilityRange' },
  { key: 'volatilityStd', label: 'Волат. σ %', gloss: 'volatilityStd' },
  { key: 'atrPct', label: 'ATR %', gloss: 'atr' },
  { key: 'changePct', label: 'Изменение %', gloss: 'change' },
  { key: 'momentumPct', label: 'Импульс %', gloss: 'momentum' },
  { key: 'trendSlopePct', label: 'Тренд %', gloss: 'trend' },
  { key: 'rsi', label: 'RSI', gloss: 'rsi' },
  { key: 'volumeRatio', label: 'Объём ×', gloss: 'volumeRatio' },
  { key: 'fundingRate', label: 'Фандинг %', gloss: 'funding' },
  { key: 'score', label: 'Скор', gloss: 'score' },
];

const DIR_WEIGHT: Record<Direction, number> = { long: 2, short: 1, wait: 0 };

export interface Row {
  symbol: string;
  price: number;
  turnover: number;
  fundingRate: number | null;
  m: SymbolMetrics | null;
  direction: Direction | null;
  confidence: number | null;
  /** Полный план на символ — для быстрого входа прямо из таблицы. */
  plan?: TradePlan | null;
  klineError: string | null;
  klineLoading: boolean;
}

export interface KlineLike {
  candles: Candle[];
  error: string | null;
  loading: boolean;
}

/** Строки таблицы: тикер + метрики + торговый план на символ. */
export function buildRows(
  symbols: string[],
  tickers: Ticker[],
  klines: KlineLike[],
  category: Category,
  interval: Interval,
): Row[] {
  const tmap = new Map(tickers.map((t) => [t.symbol, t]));
  return symbols.map((s, i) => {
    const t = tmap.get(s);
    const k = klines[i];
    const m = k && k.candles.length >= 10 ? computeMetrics(k.candles) : null;
    const plan = k && k.candles.length >= 55 && m
      ? buildTradePlan(k.candles, m, category, t?.fundingRate ?? null, interval)
      : null;
    return {
      symbol: s,
      price: t?.lastPrice ?? 0,
      turnover: t?.turnover24h ?? 0,
      fundingRate: t?.fundingRate ?? null,
      m,
      direction: plan?.direction ?? null,
      // Уверенность показываем только для направленного сетапа:
      // у wait-плана её нет, в таблице будет «—».
      confidence: plan && plan.direction !== 'wait' ? plan.confidence : null,
      plan,
      klineError: k?.error ?? null,
      klineLoading: k?.loading ?? false,
    };
  });
}

/**
 * Приоритет входа «куда действительно стоит входить» (0..100) — сортировка скринера по умолчанию.
 * База — уверенность сетапа; сверху добавляются чистота тренда (R²) и сила наклона, участие объёма;
 * штрафы за перегрев RSI (покупка на пике / продажа на дне), растянутую серию, слабый объём и шорты
 * (на бэктесте шорты систематически хуже лонгов). wait/без данных → 0.
 */
export function priorityOf(r: Row): number {
  if ((r.direction !== 'long' && r.direction !== 'short') || r.confidence == null || r.m == null) return 0;
  const m = r.m;
  // Уверенность 0..100 → 0..60 баллов.
  let p = 0.6 * r.confidence;
  // Чистота тренда: R² 0.3..1 → 0..35.
  p += Math.min(35, Math.max(0, (m.trendR2 - 0.3) * 50));
  // Сила тренда: |наклон| % за свечу 0..0.6 → 0..15.
  p += Math.min(15, Math.abs(m.trendSlopePct) * 25);
  // Участие объёма: volumeRatio 0..2 → 0..12.
  p += Math.min(12, Math.max(0, m.volumeRatio * 6));
  // Штрафы: перегретый RSI, растянутое движение, отсутствие участников.
  if (m.rsi > 78) p -= 12;
  else if (m.rsi < 22) p -= 12;
  if (Math.abs(m.streak) >= 6) p -= 8;
  if (m.volumeRatio < 0.5) p -= 10;
  // Бэктест: шорты в среднем слабее лонгов.
  if (r.direction === 'short') p -= 6;
  return Math.round(Math.min(100, Math.max(0, p)));
}

function sortVal(r: Row, sortKey: SortKey): number | string {
  switch (sortKey) {
    case 'symbol': return r.symbol;
    case 'price': return r.price;
    case 'turnover': return r.turnover;
    case 'setup': return r.direction ? DIR_WEIGHT[r.direction] : Number.NEGATIVE_INFINITY;
    case 'confidence': return r.confidence ?? Number.NEGATIVE_INFINITY;
    case 'priority': return priorityOf(r);
    case 'fundingRate': return r.fundingRate ?? Number.NEGATIVE_INFINITY;
    case 'score': return r.m?.score ?? Number.NEGATIVE_INFINITY;
    case 'volatilityRange': return r.m?.volatilityRange ?? Number.NEGATIVE_INFINITY;
    case 'volatilityStd': return r.m?.volatilityStd ?? Number.NEGATIVE_INFINITY;
    case 'atrPct': return r.m?.atrPct ?? Number.NEGATIVE_INFINITY;
    case 'changePct': return r.m?.changePct ?? Number.NEGATIVE_INFINITY;
    case 'momentumPct': return r.m?.momentumPct ?? Number.NEGATIVE_INFINITY;
    case 'trendSlopePct': return r.m?.trendSlopePct ?? Number.NEGATIVE_INFINITY;
    case 'rsi': return r.m?.rsi ?? Number.NEGATIVE_INFINITY;
    case 'volumeRatio': return r.m?.volumeRatio ?? Number.NEGATIVE_INFINITY;
  }
}

/** Сортировка строк по ключу и направлению (1 — по возрастанию, -1 — по убыванию). */
export function sortRows(rows: Row[], sortKey: SortKey, sortDir: 1 | -1): Row[] {
  return [...rows].sort((a, b) => {
    const va = sortVal(a, sortKey);
    const vb = sortVal(b, sortKey);
    if (typeof va === 'string') return sortDir * va.localeCompare(String(vb));
    return sortDir * ((va as number) - (vb as number));
  });
}

/** Фильтр «только направленные сетапы с уверенностью не ниже порога». 0 — без фильтра. */
export function filterByConfidence(rows: Row[], minConf: number): Row[] {
  if (minConf <= 0) return rows;
  return rows.filter((r) => r.direction === 'long' || r.direction === 'short')
    .filter((r) => (r.confidence ?? 0) >= minConf);
}
