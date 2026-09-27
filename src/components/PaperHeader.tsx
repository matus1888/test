import { Link } from 'react-router-dom';
import { usePaperPositions } from '../hooks/usePaper';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import { totalPnlOf } from '../lib/paper';
import { fmt } from '../lib/format';
import Term from './Term';

/** Округлённое число с группировкой разрядов (ru), например «7 463». */
const fmtInt = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v);

/** Верхняя плашка: P&L, открытые сделки и задействованный капитал. Клик — в портфель. */
export default function PaperHeader() {
  const { positions } = usePaperPositions();
  const open = positions.filter((p) => p.status === 'open');
  const prices = useLivePrices(groupByCategory(open));

  let unreal = 0;
  let engaged = 0;
  for (const p of open) {
    const r = totalPnlOf(p, prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice);
    unreal += r.net;
    engaged += r.margin; // задействованный капитал = суммарная маржа открытых (номинал/плечо)
  }
  let realized = 0;
  for (const p of positions) {
    if (p.status === 'closed') realized += totalPnlOf(p, p.closePrice ?? p.entryPrice).net;
  }
  const total = unreal + realized;
  const cls = total > 0 ? 'pos' : total < 0 ? 'neg' : '';

  return (
    <div className="topbar">
      <Link to="/" className="brand">Скринер Bybit</Link>
      <Link to="/account" className="api-link" title="Личный кабинет: быстрый доступ и статусы">Кабинет</Link>
      <button
        type="button"
        className="api-link"
        title="Обзор приложения (walkthrough)"
        onClick={() => window.dispatchEvent(new Event('open-walkthrough'))}
      >?</button>
      <Link to="/paper" className="pf-chip" title="Бумажный портфель: P&L, открытые сделки и задействованный капитал">
        <Term t="pnl" label="Портфель" />{' '}
        <b className={cls}>{total >= 0 ? '+' : ''}{fmt(total)} $</b>
        <span className="muted"> · {open.length} откр.</span>
        <span className="muted"> · <Term t="margin" label="Задействовано" /> {fmtInt(engaged)} $</span>
      </Link>
    </div>
  );
}