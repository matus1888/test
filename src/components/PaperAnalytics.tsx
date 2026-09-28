import { useMemo } from 'react';
import type { PaperPosition } from '../lib/paper';
import { closedStats, type SliceRow } from '../lib/paperStats';
import { fmt } from '../lib/format';
import Term from './Term';

/**
 * Срезы по закрытым позициям + кривая доходности (SVG).
 * Отвечает на вопрос «что реально зарабатывает»: направление, уверенность,
 * ATR, ТФ, исход — вместо одного числа общего P&L.
 */

const ROWS_VIEW = 8; // сколько строк показываем из среза, остальное скрываем

function Slice({ title, rows }: { title: string; rows: SliceRow[] }) {
  if (rows.length === 0) return null;
  const show = rows.slice(0, ROWS_VIEW);
  return (
    <div className="slice">
      <h4>{title}</h4>
      <table className="mini">
        <thead><tr><th>Срез</th><th>N</th><th>Побед</th><th>Ср.R</th><th>P&L, $</th></tr></thead>
        <tbody>
          {show.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.n}</td>
              <td>{Math.round((r.wins / Math.max(1, r.n)) * 100)}%</td>
              <td className={r.sumR / r.n >= 0 ? 'pos' : 'neg'}>{fmt(r.sumR / r.n, 2)}R</td>
              <td className={r.sumNet >= 0 ? 'pos' : 'neg'}>{fmt(r.sumNet)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROWS_VIEW && <p className="muted">…ещё {rows.length - ROWS_VIEW} среза</p>}
    </div>
  );
}

export default function PaperAnalytics({ closed }: { closed: PaperPosition[] }) {
  const stats = useMemo(() => closedStats(closed), [closed]);

  // Кривая доходности: по точкам закрытия, Y нормализуем на минимум/максимум.
  const curve = useMemo(() => {
    if (!stats || stats.equity.length < 2) return null;
    const pts = stats.equity;
    const w = 520;
    const h = 90;
    const min = Math.min(...pts.map((p) => p.cum));
    const max = Math.max(...pts.map((p) => p.cum));
    const span = max - min || 1;
    const t0 = pts[0].time;
    const t1 = pts.at(-1)!.time;
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
    const y = (v: number) => h - ((v - min) / span) * (h - 8) - 4;
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' ');
    const last = pts.at(-1)!;
    return { path, w, h, last, xOf: x(last.time), yOf: y(last.cum), zeroY: y(0) };
  }, [stats]);

  if (!stats) return null;

  return (
    <section className="analytics">
      <h3><Term t="analytics" label="Аналитика по закрытым" /></h3>
      <p className="muted">Только материализованные сделки. Срезы показывают, где реально зарабатывает стратегия, а где просто кажется.</p>
      {curve && (
        <div className="equity">
          <svg viewBox={`0 0 ${curve.w} ${curve.h}`} role="img" aria-label="Кривая доходности">
            <line x1={0} y1={curve.zeroY} x2={curve.w} y2={curve.zeroY} className="eq-zero" />
            <path d={curve.path} className="eq-path" fill="none" />
            <circle cx={curve.xOf} cy={curve.yOf} r={3} className="eq-dot" />
          </svg>
          <p className="muted">
            Итог по закрытым: <b className={curve.last.cum >= 0 ? 'pos' : 'neg'}>{fmt(curve.last.cum)} $</b> · {stats.equity.length} сделок
          </p>
        </div>
      )}
      <div className="slices">
        <Slice title="По направлению" rows={stats.byDirection} />
        <Slice title="По уверенности" rows={stats.byConf} />
        <Slice title="По ATR (ход монеты)" rows={stats.byAtr} />
        <Slice title="По таймфрейму" rows={stats.byInterval} />
        <Slice title="По исходу" rows={stats.byOutcome} />
      </div>
    </section>
  );
}