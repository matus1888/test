import { Link } from 'react-router-dom';
import { usePaperPositions } from '../hooks/usePaper';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import { pnlOf } from '../lib/paper';
import { fmt } from '../lib/format';
import Term from './Term';

/** Верхняя плашка: суммарный P&L бумажного портфеля, клик — на страницу портфеля. */
export default function PaperHeader() {
  const { positions } = usePaperPositions();
  const open = positions.filter((p) => p.status === 'open');
  const prices = useLivePrices(groupByCategory(open));

  let unreal = 0;
  for (const p of open) {
    unreal += pnlOf(p, prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice).pnl;
  }
  let realized = 0;
  for (const p of positions) {
    if (p.status === 'closed') realized += pnlOf(p, p.closePrice ?? p.entryPrice).pnl;
  }
  const total = unreal + realized;
  const cls = total > 0 ? 'pos' : total < 0 ? 'neg' : '';

  return (
    <div className="topbar">
      <Link to="/" className="brand">Скринер Bybit</Link>
      <Link to="/paper" className="pf-chip">
        <Term t="pnl" label="Портфель" />{' '}
        <b className={cls}>{total >= 0 ? '+' : ''}{fmt(total)} $</b>
        <span className="muted"> · {open.length} откр.</span>
      </Link>
    </div>
  );
}
