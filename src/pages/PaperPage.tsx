import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { fetchKlines } from '../api/bybit';
import { usePaperPositions } from '../hooks/usePaper';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import {
  closeLabel,
  evaluatePosition,
  eventLabel,
  fmtTime,
  settleOpen,
  totalPnlOf,
} from '../lib/paper';
import { fmt, fmtPct } from '../lib/format';
import { setupCls } from '../lib/ui';
import Term from '../components/Term';

export default function PaperPage() {
  const navigate = useNavigate();
  const { positions, settle, remove } = usePaperPositions();

  // Свечи по каждой позиции — для авто-закрытий и колонки «что сработало»
  const candleQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['kline', p.category, p.symbol, p.interval, 200],
      queryFn: () => fetchKlines(p.category, p.symbol, p.interval, 200),
      staleTime: 60_000,
      retry: 1,
    })),
  });

  // Материализация авто-закрытий (стоп/TP3) в localStorage
  useEffect(() => {
    const list: { id: string; info: NonNullable<ReturnType<typeof settleOpen>> }[] = [];
    positions.forEach((p, i) => {
      if (p.status !== 'open') return;
      const info = settleOpen(p, candleQueries[i]?.data);
      if (info) list.push({ id: p.id, info });
    });
    if (list.length > 0) settle(list);
  });

  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');
  const prices = useLivePrices(groupByCategory(open));

  // Качество закрытых: средний R и доля достигавших TP1 (по доступной истории свечей).
  let rSum = 0;
  let tp1n = 0;
  for (const p of closed) {
    const i = positions.indexOf(p);
    rSum += totalPnlOf(p, p.closePrice ?? p.entryPrice).netR;
    const ev = evaluatePosition(p, candleQueries[i]?.data ?? []);
    if (!ev.partial && ev.maxTp >= 1) tp1n += 1;
  }
  const avgR = closed.length > 0 ? rSum / closed.length : null;
  const tp1pct = closed.length > 0 ? Math.round((tp1n / closed.length) * 100) : null;

  const priceOf = (p: (typeof positions)[number]) =>
    p.status === 'open' ? (prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice) : (p.closePrice ?? p.entryPrice);

  const totals = positions.map((p) => totalPnlOf(p, priceOf(p)).net);
  const total = totals.reduce((a, b) => a + b, 0);
  const stakeSum = positions.reduce((a, p) => a + p.stake, 0);
  const wins = closed.filter((p) => totalPnlOf(p, p.closePrice ?? p.entryPrice).net > 0).length;

  const erase = (e: React.MouseEvent, id: string, symbol: string) => {
    e.stopPropagation();
    if (window.confirm(`Удалить позицию ${symbol} из журнала?`)) remove(id);
  };

  return (
    <div className="page">
      <Link to="/" className="back">← Назад к скринеру</Link>
      <header className="top">
        <div>
          <h1><Term t="paperTrading" label="Бумажный портфель" /></h1>
          <p className="sub">Симуляция входов из торговых планов · хранится локально в браузере</p>
        </div>
      </header>

      <section className="cards">
        <div className="card">
          <h3><Term t="pnl" label="Общий P&L" /></h3>
          <div className="lvl"><span>$</span><b className={total > 0 ? 'pos' : total < 0 ? 'neg' : ''}>{total >= 0 ? '+' : ''}{fmt(total)}</b></div>
          <div className="lvl"><span>% к марже</span><b>{stakeSum > 0 ? fmtPct((total / stakeSum) * 100) : '—'}</b></div>
        </div>
        <div className="card">
          <h3><Term t="winrate" label="Винрейт" /></h3>
          <div className="lvl"><span>Прибыльных</span><b>{closed.length > 0 ? `${wins}/${closed.length}` : '—'}</b></div>
          <div className="lvl"><span>%</span><b>{closed.length > 0 ? `${Math.round((wins / closed.length) * 100)}%` : '—'}</b></div>
        </div>
        <div className="card">
          <h3><Term t="position" label="Позиции" /></h3>
          <div className="lvl"><span>Открыто</span><b>{open.length}</b></div>
          <div className="lvl"><span>Закрыто</span><b>{closed.length}</b></div>
        </div>
        <div className="card">
          <h3><Term t="expectancy" label="Качество" /></h3>
          <div className="lvl"><span>Средний R</span><b>{avgR === null ? '—' : `${fmt(avgR, 2)}R`}</b></div>
          <div className="lvl"><span>TP1 достигал</span><b>{tp1pct === null ? '—' : `${tp1pct}%`}</b></div>
        </div>
      </section>

      {positions.length === 0 ? (
        <p className="state">Пока нет бумажных позиций. Открой первую со страницы символа — кнопка под торговым планом.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Символ</th>
                <th><Term t="direction" label="Сторона" /></th>
                <th><Term t="entryMid" label="Вход" /></th>
                <th>Выход / тек.</th>
                <th><Term t="stake" label="Ставка × плечо" /></th>
                <th><Term t="pnl" label="P&L" /></th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const exit = priceOf(p);
                const r = totalPnlOf(p, exit);
                const ev = evaluatePosition(p, candleQueries[i]?.data ?? []);
                const reached = new Set([
                  ...(p.legs ?? []).map((l) => l.reason),
                  ...ev.events.filter((e) => e.type === 'tp1' || e.type === 'tp2' || e.type === 'tp3').map((e) => e.type),
                ]);
                const tps = [...reached].map((t) => eventLabel(t as 'tp1' | 'tp2' | 'tp3'));
                return (
                  <tr key={p.id} onClick={() => navigate(`/paper/${p.id}`)}>
                    <td className="sym">{p.symbol}<br /><span className="muted">{p.category} · {p.interval}</span></td>
                    <td className={setupCls(p.direction)}>{p.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</td>
                    <td>{fmt(p.entryPrice, 4)}<br /><span className="muted">{fmtTime(p.openedAt)}</span></td>
                    <td>{fmt(exit, 4)}</td>
                    <td>{fmt(p.stake)} $ ×{p.leverage}</td>
                    <td className={r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}>
                      {r.net >= 0 ? '+' : ''}{fmt(r.net)} $ ({fmtPct(r.netPct, 1)})
                    </td>
                    <td>
                      {p.status === 'open'
                        ? <>Открыта{tps.length > 0 ? ` · ${[...new Set(tps)].join(', ')}` : ''}</>
                        : `Закрыта · ${closeLabel(p.closeReason)}`}
                    </td>
                    <td><button className="btn btn-sm" onClick={(e) => erase(e, p.id, p.symbol)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="foot">
        Открытые позиции переоцениваются по живым тикерам. TP1 фиксирует 70% позиции, TP2 — ещё 20%, остаток идёт до TP3; после TP1 стоп переносится в безубыток. P&L показан чистыми — за вычетом комиссии за круг (тейкер). Клик по строке — детальный разбор.
      </footer>
    </div>
  );
}
