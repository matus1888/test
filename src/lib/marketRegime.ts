import { priorityOf, type Row } from './screener';
import { fmt } from './format';

/**
 * Пороги режима рынка. Числа подобраны по наблюдениям бумажной сессии 28.09.2026
 * и бэктесту `bun scripts/backtest.mjs` (8 мажоров, 5 мин, лесенка 70/20/10):
 * шорты в среднем −0.36…−0.42R против +0.04…+0.33R у лонгов.
 */
export const REGIME_THRESHOLDS = {
  /** Меньше символов с метриками — вывод делать рано. */
  minAnalysed: 30,
  /** Меньше направленных сетапов — торговать нечего. */
  thinSetups: 3,
  /** Доля одной стороны в сетапах, с которой считаем перекос. */
  heavyShare: 0.6,
  /** Медианный ATR% выше — волатильно, стопы широкие, маржи нужно много. */
  wideAtr: 2.5,
  /** Медианный ATR% ниже — рынок спит. */
  deadAtr: 0.25,
  /** Уверенность, начиная с которой сетап годится для входа. */
  minConf: 70,
  /** При перекосе в шорты вход только с таким порогом уверенности. */
  shortConf: 85,
} as const;

export type RegimeVerdict = 'go' | 'cautious' | 'stand-aside' | 'no-data';

export const VERDICT_LABEL: Record<RegimeVerdict, string> = {
  go: 'Входить можно',
  cautious: 'Осторожно',
  'stand-aside': 'Лучше не входить',
  'no-data': 'Мало данных',
};

export interface RegimeSummary {
  /** Символов с посчитанными метриками. */
  analysed: number;
  /** Направленных сетапов: лонги + шорты. */
  setups: number;
  longs: number;
  shorts: number;
  /** Доли сторон среди направленных сетапов, 0..1. */
  longShare: number;
  shortShare: number;
  avgConfLong: number | null;
  avgConfShort: number | null;
  /** Медианный ATR% по выборке — волатильность рынка. */
  medianAtr: number | null;
  rising: number;
  falling: number;
  /** Средняя динамика за последние 10 свечей, %. */
  avgMomentum: number | null;
  /** Средний фандинг, % (перекос ставок лонг/шорт). */
  avgFunding: number | null;
  /** Сетапов с уверенностью не ниже порога. */
  strongCount: number;
  strongLongs: Row[];
  strongShorts: Row[];
  verdict: RegimeVerdict;
  headline: string;
  /** Что делать прямо сейчас — одной фразой. */
  action: string;
  reasons: string[];
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const byPriority = (a: Row, b: Row): number => priorityOf(b) - priorityOf(a);

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Сводка по рынку целиком и вердикт «стоит ли входить».
 *
 * Считается по всем просканированным символам, а не по таблице после фильтра
 * по уверенности: перекос сторон виден именно в полной выборке.
 * `openByDirection` (по открытым бумажным позициям) добавляет предупреждение
 * о том, что новые позиции в ту же сторону наращивать не стоит.
 */
export function summarizeRegime(
  rows: Row[],
  openByDirection?: { long: number; short: number },
): RegimeSummary {
  const withM = rows.filter((r) => r.m);
  const longs = rows.filter((r) => r.direction === 'long');
  const shorts = rows.filter((r) => r.direction === 'short');
  const setups = longs.length + shorts.length;
  const longShare = setups ? longs.length / setups : 0;
  const shortShare = setups ? shorts.length / setups : 0;

  const confidences = [...longs, ...shorts].map((r) => r.confidence ?? 0);
  const medianAtr = median(withM.map((r) => r.m!.atrPct));
  const rising = withM.filter((r) => r.m!.changePct > 0).length;
  const falling = withM.filter((r) => r.m!.changePct < 0).length;
  const avgFunding = avg(
    rows.map((r) => r.fundingRate).filter((v): v is number => v !== null),
  );

  const strongCount = confidences.filter((c) => c >= REGIME_THRESHOLDS.minConf).length;
  const reasons: string[] = [];
  let verdict: RegimeVerdict;
  let headline: string;
  let action: string;

  if (withM.length < REGIME_THRESHOLDS.minAnalysed) {
    verdict = 'no-data';
    headline = `Данных пока мало: ${withM.length} символов с метриками`;
    action = 'Дождись, пока сканер докачает выборку свечей, и открой обзор ещё раз.';
    reasons.push(`Нужно минимум ${REGIME_THRESHOLDS.minAnalysed} символов с метриками, иначе вывод делать рано.`);
  } else if (setups < REGIME_THRESHOLDS.thinSetups) {
    verdict = 'stand-aside';
    headline = setups === 0
      ? 'Направленных сетапов нет совсем'
      : `Направленных сетапов всего ${setups} — входить не в что`;
    action = 'Не входить. Сетапы появляются вместе с новой свечой — пересмотри через 1–2 минуты.';
    reasons.push(`Порог: от ${REGIME_THRESHOLDS.thinSetups} направленных сетапов.`);
  } else if (shortShare >= REGIME_THRESHOLDS.heavyShare) {
    verdict = 'stand-aside';
    headline = `Перекос в шорты: ${pct(shortShare)} сетапов на падение`;
    action = 'Лучше не входить. Шорты — самая слабая сторона статистики, а лонгов в списке почти нет. Дождись разворота.';
    reasons.push(`Перекос: шортов ${shorts.length}, лонгов ${longs.length} (порог ${pct(REGIME_THRESHOLDS.heavyShare)}).`);
    reasons.push('Бэктест 28.09.2026: шорты в среднем −0.36…−0.42R против +0.04…+0.33R у лонгов.');
    if (openByDirection && openByDirection.short > 0) {
      reasons.push(`У тебя уже открыто шортов: ${openByDirection.short} — новые шорты не наращивай.`);
    }
  } else if (longShare >= REGIME_THRESHOLDS.heavyShare) {
    verdict = 'go';
    headline = `Перекос в лонги: ${pct(longShare)} сетапов на рост`;
    action = `Входить можно, приоритет у лонгов. Бери сетапы с уверенностью от ${REGIME_THRESHOLDS.minConf}% и высоким приоритетом.`;
    reasons.push(`Перекос в пользу лонгов: лонгов ${longs.length}, шортов ${shorts.length} (порог ${pct(REGIME_THRESHOLDS.heavyShare)}).`);
    reasons.push(`Сетапов с уверенностью от ${REGIME_THRESHOLDS.minConf}%: ${strongCount}.`);
  } else {
    verdict = 'cautious';
    headline = 'Сетапы в обе стороны, явного перекоса нет';
    action = `Точечный вход: 1–2 позиции по приоритету, риск 1–2% как обычно, без добора объёма.`;
    reasons.push(`Лонгов ${longs.length}, шортов ${shorts.length} — баланс.`);
    reasons.push(`Сетапов с уверенностью от ${REGIME_THRESHOLDS.minConf}%: ${strongCount}.`);
  }

  // Волатильность — корректирующий фактор: она не отменяет сигнал, но меняет вход.
  if (verdict !== 'no-data' && medianAtr !== null) {
    if (medianAtr > REGIME_THRESHOLDS.wideAtr) {
      if (verdict === 'go') { verdict = 'cautious'; headline += ' · волатильно'; }
      reasons.push(`Волатильность высокая: медианный ATR ${fmt(medianAtr)}% — стопы широкие, при риске 2% номинал потребует много маржи.`);
    } else if (medianAtr < REGIME_THRESHOLDS.deadAtr) {
      if (verdict === 'go') { verdict = 'cautious'; headline += ' · рынок вялый'; }
      reasons.push(`Рынок низковолатильный: медианный ATR ${fmt(medianAtr)}% — движения вялые, тейки достигаются редко.`);
    }
  }

  return {
    analysed: withM.length,
    setups,
    longs: longs.length,
    shorts: shorts.length,
    longShare,
    shortShare,
    avgConfLong: avg(longs.map((r) => r.confidence ?? 0)),
    avgConfShort: avg(shorts.map((r) => r.confidence ?? 0)),
    medianAtr,
    rising,
    falling,
    avgMomentum: avg(withM.map((r) => r.m!.momentumPct)),
    avgFunding,
    strongCount,
    strongLongs: [...longs].sort(byPriority).slice(0, 3),
    strongShorts: [...shorts].sort(byPriority).slice(0, 3),
    verdict,
    headline,
    action,
    reasons,
  };
}
