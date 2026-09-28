import type { Row } from './screener';
import { fmt, fmtCompact } from './format';

/**
 * Пороги «сомнительной» пары. Числа подобраны по замеру рынка 28.09.2026
 * (см. SESSION-MAINNET.md): выборка из 200 линейных монет даёт медианный ATR 0.56 %,
 * а в неё попадают токенизированные акции (GOOGL, PANW, SKHY) и золото (XAU/PAXG)
 * с ATR 0.09–0.25 % и оборотом от 2.3 до 10.9 млн $.
 */
export const SUSPICIOUS = {
  /** Оборот 24ч ниже — тонкий рынок: стоп цепляет шум, выход дорогой. */
  minTurnover: 10_000_000,
  /** ATR% ниже — цена почти не ходит, наши тейки 1R/2R/3R за сессию не берутся. */
  minAtrPct: 0.25,
} as const;

export type Suspicion = 'liquidity' | 'volatility' | 'size';

export const SUSPICION_LABEL: Record<Suspicion, string> = {
  liquidity: `мало ликвидности (оборот < ${fmtCompact(SUSPICIOUS.minTurnover)} в сутки)`,
  volatility: `вялый ход (ATR < ${fmt(SUSPICIOUS.minAtrPct)}%)`,
  size: 'не влезает по марже на наш риск',
};

export interface SuspicionOpts {
  /** Риск в деньгах на сделку: депозит × риск%. */
  riskMoney: number;
  leverage: number;
  /** Потолок маржи (ставка): больше него вход всё равно заблокирован. */
  stake: number;
}

export interface HiddenPair {
  row: Row;
  reasons: Suspicion[];
}

/**
 * Маржа, которую займёт позиция по плану строки при заданном риске и плече.
 * null — если направленного плана нет (wait) или параметры некорректны.
 * Формула та же, что в `entryBlockReason`: размер = риск / дистанция до стопа.
 */
export function marginFor(r: Row, riskMoney: number, leverage: number): number | null {
  const p = r.plan;
  if (!p || (p.direction !== 'long' && p.direction !== 'short')) return null;
  if (!(p.entryMid > 0) || !(p.riskDist > 0) || !(riskMoney > 0) || !(leverage > 0)) return null;
  return ((riskMoney / p.riskDist) * p.entryMid) / leverage;
}

/** Почему строка считается сомнительной: пустой массив — пара нормальная (если метрики есть). */
export function suspicionsOf(r: Row, opts: SuspicionOpts): Suspicion[] {
  const out: Suspicion[] = [];
  if (r.turnover < SUSPICIOUS.minTurnover) out.push('liquidity');
  // Без метрик (свечи грузятся или ошибка) ничего не режем: иначе таблица мигает на старте.
  if (r.m && r.m.atrPct < SUSPICIOUS.minAtrPct) out.push('volatility');
  const margin = marginFor(r, opts.riskMoney, opts.leverage);
  if (margin !== null && margin > opts.stake) out.push('size');
  return out;
}

/** Разделяет выборку на «нормальные» пары и отсеянные (с причинами — показать пользователю). */
export function splitSuspicious(
  rows: Row[],
  opts: SuspicionOpts,
): { kept: Row[]; hidden: HiddenPair[] } {
  const kept: Row[] = [];
  const hidden: HiddenPair[] = [];
  for (const row of rows) {
    const reasons = suspicionsOf(row, opts);
    if (reasons.length === 0) kept.push(row);
    else hidden.push({ row, reasons });
  }
  return { kept, hidden };
}

/** Сколько скрытых пар отсеяно по каждой причине (причины пересекаются). */
export function hiddenReasonsCount(hidden: HiddenPair[]): Record<Suspicion, number> {
  const out: Record<Suspicion, number> = { liquidity: 0, volatility: 0, size: 0 };
  for (const h of hidden) for (const reason of h.reasons) out[reason] += 1;
  return out;
}
