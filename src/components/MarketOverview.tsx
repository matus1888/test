import { useEffect, useMemo, useState } from 'react';
import type { Category, Interval } from '../api/bybit';
import { INTERVAL_LABELS } from '../api/bybit';
import { fmt, fmtPct } from '../lib/format';
import { numCls } from '../lib/ui';
import {
  REGIME_THRESHOLDS,
  summarizeRegime,
  VERDICT_LABEL,
  type RegimeSummary,
  type RegimeVerdict,
} from '../lib/marketRegime';
import { hiddenReasonsCount, type HiddenPair } from '../lib/pairFilter';
import { priorityOf, type Row } from '../lib/screener';
import Term from './Term';
import PairLink from './PairLink';

const VERDICT_CLS: Record<RegimeVerdict, string> = {
  go: 'mo-verdict go',
  cautious: 'mo-verdict cautious',
  'stand-aside': 'mo-verdict bad',
  'no-data': 'mo-verdict',
};

function TopList({ title, rows, category, cls }: { title: string; rows: Row[]; category: Category; cls?: string }) {
  return (
    <div>
      <b className={cls}><Term t="priority" label={title} /></b>
      {rows.length === 0
        ? <p className="muted mo-empty">—</p>
        : (
          <ul>
            {rows.map((r) => (
              <li key={r.symbol}>
                <b><PairLink symbol={r.symbol} category={category} /></b>
                <span className="muted">
                  {' '}· уверенность {r.confidence ?? 0}% · приоритет {priorityOf(r)} · ATR {fmt(r.m?.atrPct)}%
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

/**
 * Кнопка «Обзор рынка» + модальное окно со сводкой по рынку и вердиктом:
 * стоит ли сейчас входить вообще. Считается по всем просканированным символам
 * (после отсева сомнительных), поэтому не совпадает с таблицей, отфильтрованной
 * по уверенности.
 */
export default function MarketOverview({
  rows,
  category,
  interval,
  openByDirection,
  hidden = [],
  loading = false,
}: {
  rows: Row[];
  category: Category;
  interval: Interval;
  openByDirection?: { long: number; short: number };
  hidden?: HiddenPair[];
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sum: RegimeSummary = useMemo(
    () => summarizeRegime(rows, openByDirection),
    [rows, openByDirection],
  );
  const reasons = useMemo(() => hiddenReasonsCount(hidden), [hidden]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shortsHeavy = sum.shortShare >= REGIME_THRESHOLDS.heavyShare;
  const hiddenLine = hidden.length > 0
    ? `Отсеяно сомнительных пар: ${hidden.length} (ликвидность ${reasons.liquidity}, вялый ход ${reasons.volatility}, не влезает по марже ${reasons.size})`
    : 'Сомнительные пары не отсеивались';

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Обзор рынка<Term t="marketOverview" />
      </button>

      {open && (
        <div className="wt-backdrop" onClick={() => setOpen(false)}>
          <div
            className="wt-panel mo-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Обзор рынка"
          >
            <div className="wt-head">
              <h3>Обзор рынка<Term t="marketOverview" /></h3>
              <span className="muted">{category} · {INTERVAL_LABELS[interval]} · {sum.analysed} символов</span>
            </div>

            <div className={VERDICT_CLS[sum.verdict]}>
              <b>{VERDICT_LABEL[sum.verdict]}</b>
              <span className="muted">{' '}<Term t="marketVerdict" /></span>
              <div className="mo-headline">{sum.headline}</div>
              <p className="mo-action">{sum.action}</p>
            </div>

            <div className="mo-grid">
              <div className="mo-card">
                <span className="muted">Сетапы лонг / шорт</span>
                <b className="pos">{sum.longs}</b>
                <b className={shortsHeavy ? 'neg' : 'muted'}>{sum.shorts}</b>
                <span className="muted">
                  шорты {Math.round(sum.shortShare * 100)}% · порог {Math.round(REGIME_THRESHOLDS.heavyShare * 100)}%
                </span>
              </div>
              <div className="mo-card">
                <span className="muted">Средняя уверенность</span>
                <b>лонг {fmt(sum.avgConfLong, 0)}%</b>
                <b>шорт {fmt(sum.avgConfShort, 0)}%</b>
                <span className="muted">порог входа {REGIME_THRESHOLDS.minConf}%</span>
              </div>
              <div className="mo-card">
                <span className="muted">Волатильность (ATR)</span>
                <b>медиана {fmt(sum.medianAtr)}%</b>
                <b className="muted">сильный {REGIME_THRESHOLDS.wideAtr}% / вялый {REGIME_THRESHOLDS.deadAtr}%</b>
                <span className="muted">растут {sum.rising} · падают {sum.falling}</span>
              </div>
              <div className="mo-card">
                <span className="muted">Импульс и фандинг</span>
                <b className={numCls(sum.avgMomentum)}>{fmtPct(sum.avgMomentum)}</b>
                <b className="muted">фандинг {fmt((sum.avgFunding ?? 0) * 100, 4)}%</b>
                <span className="muted">сильных сетапов: {sum.strongCount}</span>
              </div>
            </div>

            <div className="mo-lists">
              <TopList title="Лучшие лонги" rows={sum.strongLongs} category={category} cls="pos" />
              <TopList title="Лучшие шорты" rows={sum.strongShorts} category={category} cls={shortsHeavy ? 'neg' : undefined} />
            </div>

            <ul className="mo-reasons">
              {sum.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>

            <p className="mo-note">
              Сводка считается по всем просканированным символам, а не по таблице после фильтра
              «уверенность от …» — поэтому числа могут отличаться от числа строк на экране.
              {loading ? ' Данные сейчас обновляются.' : ''} {hiddenLine}.
            </p>

            <div className="wt-nav">
              <span className="muted">Esc — закрыть</span>
              <button className="btn open-long" onClick={() => setOpen(false)}>Понятно</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
