import type { Interval } from '../api/bybit';

/**
 * Длительность свечи по таймфрейму, мс. Используется, чтобы не дёргать kline
 * чаще, чем меняются сами свечи: на 5 мин свечах 60-секундный авторефреш
 * возвращает ту же самую ещё не закрытую свечу.
 */
export const INTERVAL_MS: Record<Interval, number> = {
  '1': 60_000,
  '3': 180_000,
  '5': 300_000,
  '15': 900_000,
  '30': 1_800_000,
  '60': 3_600_000,
  '120': 7_200_000,
  '240': 14_400_000,
  '360': 21_600_000,
  '720': 43_200_000,
  D: 86_400_000,
  W: 604_800_000,
  M: 2_592_000_000,
};

/** Запас на выгрузку биржи, чтобы не поймать ещё не сформированную свечу. */
const CANDLE_MARGIN_MS = 400;

/** Ключ свечей для карты «символ+ТФ → свечи»: одинаковые ключи дедуплицируются. */
export const candleKey = (
  category: string,
  symbol: string,
  interval: Interval,
): string => `${category}:${symbol}:${interval}`;

/** Сколько миллисекунд до закрытия текущей свечи (с запасом). */
export function msToNextCandle(interval: Interval, now = Date.now()): number {
  const ms = INTERVAL_MS[interval];
  return ms - (now % ms) + CANDLE_MARGIN_MS;
}

/**
 * Эффективный период цикла обновления: пользовательский выбор, но не чаще
 * `минимального шага` — 15 с на 1–3 мин и 75 с на таймфреймах от 5 мин.
 * Это защита биржи от 429, а не привязка к закрытию свечи: незакрытая свеча
 * меняется, поэтому данные на экране остаются свежими.
 * `false` — автообновление выключено, цикла нет.
 */
export function effectiveCycleMs(interval: Interval, wantMs: number | false): number | false {
  if (wantMs === false) return false;
  const floor = Math.min(INTERVAL_MS[interval] / 4, 75_000);
  return Math.max(wantMs, floor, 15_000);
}

/** Бюджет запросов kline: сколько символов обновляем за цикл. */
export const REFRESH_BUDGET = {
  /** За сколько циклов проходим всю выборку целиком. */
  sweeps: 12,
  /** Сколько самых ликвидных символов (сортировка по обороту) обновляем каждый цикл. */
  hot: 6,
  /** Потолок за один цикл — защита от 429. */
  maxPerCycle: 20,
  /** Потолок в минуту: не зависит от того, как часто выбран цикл. */
  maxPerMinute: 15,
} as const;

export interface BudgetOpts {
  sweeps?: number;
  hot?: number;
  maxPerCycle?: number;
  maxPerMinute?: number;
}

/** Сколько «горячих» символов реально помещается в выборку и в бюджет. */
function hotOf(total: number, perCycle: number, hot: number): number {
  return Math.max(0, Math.min(hot, perCycle, total));
}

/**
 * Сколько символов обновлять за цикл.
 *
 * Считаем от скорости обхода: `hot` самых ликвидных символов обновляем каждый
 * цикл, а остальные делим на `sweeps` частей — иначе обход растянулся бы в
 * `sweeps × hot / perCycle` раз дольше заявленного. Дальше режем по потолкам:
 * запросов за цикл и запросов в минуту (защита от 429).
 */
export function perCycleFor(
  total: number,
  cycleMs: number,
  over: BudgetOpts = {},
): number {
  if (total <= 0) return 0;
  const sweeps = Math.max(1, over.sweeps ?? REFRESH_BUDGET.sweeps);
  const hot = Math.min(over.hot ?? REFRESH_BUDGET.hot, total);
  const slice = Math.ceil((total - hot) / sweeps);
  const byRate = Math.floor(((over.maxPerMinute ?? REFRESH_BUDGET.maxPerMinute) * cycleMs) / 60_000);
  return Math.max(
    1,
    Math.min(hot + slice, over.maxPerCycle ?? REFRESH_BUDGET.maxPerCycle, total, byRate || total),
  );
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Шаг прокрутки «холодной» части выборки. Взят взаимно простым с её длиной,
 * иначе при шаге 2 по кругу длины 10 половина символов не обновлялась бы никогда.
 */
function coprimeStep(slice: number, total: number): number {
  for (let s = Math.max(1, slice); s < total; s += 1) {
    if (gcd(s, total) === 1) return s;
  }
  return 1;
}

/**
 * Индексы символов, которые обновляем в цикле `cycle`: первые `hot` (самые
 * ликвидные) — всегда, остальные — по круговой очереди. Возвращает все индексы,
 * если бюджет не задан или не меньше выборки.
 */
export function planRefresh(
  total: number,
  cycle: number,
  opts: { perCycle: number; hot?: number } = { perCycle: 0 },
): number[] {
  if (total <= 0) return [];
  const perCycle = opts.perCycle;
  if (!perCycle || perCycle >= total) return Array.from({ length: total }, (_, i) => i);
  const hot = hotOf(total, perCycle, opts.hot ?? REFRESH_BUDGET.hot);
  const coldTotal = total - hot;
  const slice = perCycle - hot;
  const out: number[] = [];
  for (let i = 0; i < hot; i += 1) out.push(i);
  if (coldTotal > 0 && slice > 0) {
    const step = coprimeStep(slice, coldTotal);
    const start = (cycle * step) % coldTotal;
    for (let k = 0; k < Math.min(slice, coldTotal); k += 1) out.push(hot + ((start + k) % coldTotal));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Сколько циклов нужно, чтобы обойти всю выборку (без повторов по «горячим»). */
export function sweepCycles(total: number, perCycle: number, hot?: number): number {
  if (total <= 0 || perCycle >= total) return 1;
  const h = hotOf(total, perCycle, hot ?? REFRESH_BUDGET.hot);
  const slice = perCycle - h;
  return slice > 0 ? Math.ceil((total - h) / slice) : 1;
}

/** Человеческое описание режима обновления — показываем в строке состояния. */
export function describeRefresh(total: number, perCycle: number, cycleMs: number): string {
  if (total <= 0) return '';
  const mins = Math.max(1, Math.round((sweepCycles(total, perCycle) * cycleMs) / 60_000));
  return `${perCycle} из ${total} за цикл · цикл ${Math.max(1, Math.round(cycleMs / 1000))} с · полный обход ~${mins} мин`;
}
