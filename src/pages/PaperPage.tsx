import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { fetchKlines, type Candle } from '../api/bybit';
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
import { fmt, fmtCompact, fmtPct } from '../lib/format';
import { rowKeyProps, setupCls } from '../lib/ui';
import Term from '../components/Term';

export default function PaperPage() {
  const navigate = useNavigate();
  const { positions, settle, remove, closeManual } = usePaperPositions();

  // Свечи по каждой позиции — для авто-закрытий и колонки «что сработало».
  // `combine` мемоизирует результат: карта стабильна между рендерами, поэтому
  // эффект ниже не пересчитывается на каждый рендер.
  const candlesByPos = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['kline', p.category, p.symbol, p.interval, 200],
      queryFn: () => fetchKlines(p.category, p.symbol, p.interval, 200),
      staleTime: 60_000,
      retry: 1,
    })),
    combine: (results) => {
      const m = new Map<string, Candle[]>();
      positions.forEach((p, i) => {
        const data = results[i]?.data;
        if (data) m.set(p.id, data);
      });
      return m;
    },
  });

  // Материализация авто-закрытий (стоп/TP3) в localStorage
  useEffect(() => {
    const list: { id: string; info: NonNullable<ReturnType<typeof settleOpen>> }[] = [];
    for (const p of positions) {
      if (p.status !== 'open') continue;
      const info = settleOpen(p, candlesByPos.get(p.id));
      if (info) list.push({ id: p.id, info });
    }
    if (list.length > 0) settle(list);
  }, [positions, candlesByPos, settle]);

  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');
  const prices = useLivePrices(groupByCategory(open));

  // Качество закрытых: средний R и доля достигавших TP1 (по доступной истории свечей).
  let rSum = 0;
  let tp1n = 0;
  for (const p of closed) {
    rSum += totalPnlOf(p, p.closePrice ?? p.entryPrice).netR;
    const ev = evaluatePosition(p, candlesByPos.get(p.id) ?? []);
    if (!ev.partial && ev.maxTp >= 1) tp1n += 1;
  }
  const avgR = closed.length > 0 ? rSum / closed.length : null;
  const tp1pct = closed.length > 0 ? Math.round((tp1n / closed.length) * 100) : null;

  const priceOf = (p: (typeof positions)[number]) =>
    p.status === 'open' ? (prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice) : (p.closePrice ?? p.entryPrice);

  const totals = positions.map((p) => totalPnlOf(p, priceOf(p)).net);
  const total = totals.reduce((a, b) => a + b, 0);
  let stakeSum = 0;
  let marginSum = 0;
  for (const p of positions) {
    const r = totalPnlOf(p, priceOf(p));
    stakeSum += p.stake;
    marginSum += r.margin;
  }
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
          <div className="lvl"><span><Term t="pnl" label="Общий P&L" /></span><b className={total > 0 ? 'pos' : total < 0 ? 'neg' : ''}>{total >= 0 ? '+' : ''}{fmt(total)}</b></div>
          <div className="lvl"><span>% к ставке</span><b>{stakeSum > 0 ? fmtPct((total / stakeSum) * 100) : '—'}</b></div>
          <div className="lvl"><span><Term t="margin" label="% к марже" /></span><b>{marginSum > 0 ? fmtPct((total / marginSum) * 100) : '—'}</b></div>
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
                <th><Term t="stake" label="Ставка / маржа" /></th>
                <th><Term t="pnl" label="P&L" /></th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const exit = priceOf(p);
                const r = totalPnlOf(p, exit);
                const ev = evaluatePosition(p, candlesByPos.get(p.id) ?? []);
                const reached = new Set([
                  ...(p.legs ?? []).map((l) => l.reason),
                  ...ev.events.filter((e) => e.type === 'tp1' || e.type === 'tp2' || e.type === 'tp3').map((e) => e.type),
                ]);
                const tps = [...reached].map((t) => eventLabel(t as 'tp1' | 'tp2' | 'tp3'));
                return (
                  <tr key={p.id} {...rowKeyProps(() => navigate(`/paper/${p.id}`), `Разбор позиции ${p.symbol}`)}>
                    <td className="sym">{p.symbol}<br /><span className="muted">{p.category} · {p.interval}</span></td>
                    <td className={setupCls(p.direction)}>{p.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</td>
                    <td>{fmt(p.entryPrice, 4)}<br /><span className="muted">{fmtTime(p.openedAt)}</span></td>
                    <td>{fmt(exit, 4)}</td>
                    <td>{fmt(p.stake)} $ ×{p.leverage}<br /><span className="muted">маржа {fmt(r.margin)} $ · номинал {fmtCompact(r.notional)}</span></td>
                    <td className={r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}>
                      {r.net >= 0 ? '+' : ''}{fmt(r.net)} $ ({fmtPct(r.netMarginPct, 1)})
                    </td>
                    <td>
                      {p.status === 'open'
                        ? <>Открыта{tps.length > 0 ? ` · ${[...new Set(tps)].join(', ')}` : ''}</>
                        : `Закрыта · ${closeLabel(p.closeReason)}`}
                    </td>
                    <td>
                      {p.status === 'open' && (
                        <button
                          className="btn btn-sm"
                          onClick={(e) => { e.stopPropagation(); closeManual(p.id, exit, Date.now()); }}
                          title={`Закрыть по текущей цене ${fmt(exit, 4)}`}
                        >Закрыть</button>
                      )}
                      <button className="btn btn-sm" onClick={(e) => erase(e, p.id, p.symbol)}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="foot">
        Открытые позиции переоцениваются по живым тикерам. TP1 фиксирует 70% позиции, TP2 — ещё 20%, остаток идёт до TP3; после TP1 стоп переносится в безубыток. P&L показан чистыми — за вычетом комиссии за круг (тейкер). P&L в $ = движение цены × количество и не зависит от плеча; проценты — к марже (номинал/плечо) и к ставке. Клик по строке — детальный разбор.
      </footer>
    </div>
  );
}
