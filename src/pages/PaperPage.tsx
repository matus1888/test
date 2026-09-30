import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { fetchKlines, type Candle } from '../api/bybit';
import { usePaperPositions } from '../hooks/usePaper';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import {
  closeLabel,
  evaluatePosition,
  eventLabel,
  fillsFor,
  fmtDuration,
  fmtTime,
  limitGap,
  pendingMargin,
  settleOpen,
  staleLimits,
  totalPnlOf,
  type PaperPosition,
} from '../lib/paper';
import { candleKey, effectiveCycleMs } from '../lib/klinePlan';
import { fmt, fmtCompact, fmtPct, fmtPctAbs } from '../lib/format';
import { rowKeyProps, setupCls } from '../lib/ui';
import Term from '../components/Term';
import PairLink from '../components/PairLink';
import EnvBadge from '../components/EnvBadge';
import PaperAnalytics from '../components/PaperAnalytics';
import { useConfirm } from '../components/Confirm';
import { useSessionState } from '../hooks/useSessionState';

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export default function PaperPage() {
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const { positions, settle, fill, cancelPending, remove, closeManual, closeAll } = usePaperPositions();
  // «Сколько заявка в рынке» — тик раз в минуту: дёшево, а возраст виден сразу.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  // Свечи по каждой позиции — для авто-закрытий и колонки «что сработало».
  // Ключи дедуплицируются: две позиции по одному символу и ТФ — это один запрос,
  // а не два одинаковых ключа (на это ругается React Query).
  // Обновляем по закрытию свечи: стопы и тейки проверяются на закрытых свечах,
  // а рефетч каждые 30 с на 5 мин просто повторял один и тот же ответ.
  const uniqueKlines = useMemo(() => {
    const m = new Map<string, PaperPosition>();
    for (const p of positions) m.set(candleKey(p.category, p.symbol, p.interval), p);
    return [...m.values()];
  }, [positions]);

  // `combine` мемоизирует результат: карта стабильна между рендерами, поэтому
  // эффект ниже не пересчитывается на каждый рендер.
  const candlesByPos = useQueries({
    queries: uniqueKlines.map((p) => ({
      queryKey: ['kline', p.category, p.symbol, p.interval, 200],
      queryFn: () => fetchKlines(p.category, p.symbol, p.interval, 200),
      staleTime: effectiveCycleMs(p.interval, 60_000) || 60_000,
      refetchInterval: effectiveCycleMs(p.interval, 60_000) || 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    })),
    combine: (results) => {
      const m = new Map<string, Candle[]>();
      uniqueKlines.forEach((p, i) => {
        const data = results[i]?.data;
        if (data) m.set(candleKey(p.category, p.symbol, p.interval), data);
      });
      return m;
    },
  });

  const open = positions.filter((p) => p.status === 'open');
  const pending = positions.filter((p) => p.status === 'pending');
  const closed = positions.filter((p) => p.status === 'closed');
  // Живые цены нужны и открытым (переоценка), и заявкам в рынке (проверка касания лимита).
  const prices = useLivePrices(groupByCategory([...open, ...pending]));

  const liveOf = useCallback((p: PaperPosition) => prices.get(`${p.category}:${p.symbol}`) ?? null, [prices]);
  const candlesOf = useCallback(
    (p: PaperPosition) => candlesByPos.get(candleKey(p.category, p.symbol, p.interval)),
    [candlesByPos],
  );

  // Материализация заявок (исполнение лимита, снятие протухших) и авто-закрытий
  // (стоп/безубыток/TP3) в localStorage. Пишет только при реальном переходе
  // статуса, поэтому пересчёт на каждом тике цен ничего не меняет в покое.
  useEffect(() => {
    // `now` по умолчанию берётся внутри движка: заявка либо уже задела лимит
    // (по истории свечей или по живой цене), либо протухла по TTL.
    fill(fillsFor(positions, candlesOf, liveOf));
    const stale = staleLimits(positions);
    if (stale.length > 0) cancelPending(stale);
    const list: { id: string; info: NonNullable<ReturnType<typeof settleOpen>> }[] = [];
    for (const p of positions) {
      if (p.status !== 'open') continue;
      const info = settleOpen(p, candlesOf(p));
      if (info) list.push({ id: p.id, info });
    }
    if (list.length > 0) settle(list);
  }, [positions, candlesOf, liveOf, fill, cancelPending, settle]);

  // Качество закрытых: средний R и доля достигавших TP1 (по доступной истории свечей).
  let rSum = 0;
  let tp1n = 0;
  for (const p of closed) {
    rSum += totalPnlOf(p, p.closePrice ?? p.entryPrice).netR;
    const ev = evaluatePosition(p, candlesByPos.get(candleKey(p.category, p.symbol, p.interval)) ?? []);
    if (!ev.partial && ev.maxTp >= 1) tp1n += 1;
  }
  const avgR = closed.length > 0 ? rSum / closed.length : null;
  const tp1pct = closed.length > 0 ? Math.round((tp1n / closed.length) * 100) : null;

  const priceOf = (p: (typeof positions)[number]) =>
    p.status === 'open' ? (prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice) : (p.closePrice ?? p.entryPrice);

  // В зачёт портфеля идут только исполненные сделки: заявка в рынке — это ноль.
  const traded = positions.filter((p) => p.status === 'open' || p.status === 'closed');
  const totals = traded.map((p) => totalPnlOf(p, priceOf(p)).net);
  const total = totals.reduce((a, b) => a + b, 0);
  let stakeSum = 0;
  let marginSum = 0;
  for (const p of traded) {
    const r = totalPnlOf(p, priceOf(p));
    stakeSum += p.stake;
    marginSum += r.margin;
  }
  const wins = closed.filter((p) => totalPnlOf(p, p.closePrice ?? p.entryPrice).net > 0).length;

  // Сколько денег депозита реально занято открытыми сделками: сумма марж (номинал/плечо).
  let openMargin = 0;
  let openNotional = 0;
  for (const p of open) {
    const r = totalPnlOf(p, priceOf(p));
    openMargin += r.margin;
    openNotional += r.notional;
  }
  const deposit = useSessionState<number>('symbol:deposit', 1000, isPositiveNumber)[0];
  const pendingMarginSum = pendingMargin(positions);

  const erase = async (e: React.MouseEvent, id: string, symbol: string) => {
    e.stopPropagation();
    if (await confirm({ title: 'Удалить запись?', text: `Запись по ${symbol} исчезнет из журнала.`, ok: 'Удалить', danger: true })) {
      remove(id);
    }
  };

  return (
    <div className="page">
      {confirmDialog}
      <Link to="/" className="back">← Назад к скринеру</Link>
      <header className="top">
        <div>
          <h1><Term t="paperTrading" label="Бумажный портфель" /> <EnvBadge kind="paper" label="БУМАГА" title="Виртуальные сделки: реальные деньги не двигаются" /></h1>
          <p className="sub">
            Симуляция входов из торговых планов · хранится локально в браузере.
            {' '}Реальные ордера — страница <Link to="/live">/live</Link>, реальный счёт — <Link to="/real">/real</Link>.
          </p>
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
          <div className="lvl"><span><Term t="limitOrder" label="Лимитов в рынке" /></span><b>{pending.length}</b></div>
          <div className="lvl">
            <span><Term t="margin" label="Занято из депозита" /></span>
            <b>{open.length > 0 ? `${fmt(openMargin)} $ · ${fmtPct((openMargin / deposit) * 100, 0)}` : '—'}</b>
          </div>
          {pending.length > 0 && (
            <div className="lvl">
              <span className="muted">В резерве под лимиты</span>
              <b className="muted">{fmt(pendingMarginSum)} $</b>
            </div>
          )}
          <div className="lvl">
            <span>Торговый номинал</span>
            <b className="muted">{open.length > 0 ? `${fmtCompact(openNotional)} $ (×${(openNotional / Math.max(openMargin, 1)).toFixed(1)} к марже)` : '—'}</b>
          </div>
        </div>
        <div className="card">
          <h3><Term t="expectancy" label="Качество" /></h3>
          <div className="lvl"><span>Средний R</span><b>{avgR === null ? '—' : `${fmt(avgR, 2)}R`}</b></div>
          <div className="lvl"><span>TP1 достигал</span><b>{tp1pct === null ? '—' : `${tp1pct}%`}</b></div>
        </div>
      </section>

      {positions.length === 0 ? (
        <p className="state">Пока нет бумажных заявок. Поставь первую со страницы символа — кнопка под торговым планом.</p>
      ) : (
        <>
          {open.length > 0 && (
            <div className="table-actions">
              {/* Раньше кнопка была disabled: нативный confirm ронял вкладку после
                  accept. С подтверждением внутри приложения (components/Confirm.tsx)
                  нативного диалога здесь нет — падать нечему. */}
              <button
                className="btn btn-sm btn-close-all"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Закрыть все позиции?',
                    text: `Открытых позиций: ${open.length}. Закрытие по текущим ценам.\nЗаявки в рынке не задеты — они снимаются.`,
                    ok: 'Закрыть всё',
                    danger: true,
                  });
                  if (ok) closeAll(priceOf);
                }}
              >Закрыть все</button>
            </div>
          )}
          <div className="table-wrap">
          <table className="pin-right">
            <thead>
              <tr>
                <th>Символ</th>
                <th><Term t="direction" label="Сторона" /></th>
                <th><Term t="entryMid" label="Вход" /></th>
                <th>Выход / тек.</th>
                <th>Из депозита в сделке</th>
                <th><Term t="pnl" label="P&L" /></th>
                <th>Статус</th>
                <th className="act"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const isPending = p.status === 'pending';
                const exit = priceOf(p);
                const r = totalPnlOf(p, exit);
                const ev = evaluatePosition(p, candlesByPos.get(candleKey(p.category, p.symbol, p.interval)) ?? []);
                const reached = new Set([
                  ...(p.legs ?? []).map((l) => l.reason),
                  ...ev.events.filter((e) => e.type === 'tp1' || e.type === 'tp2' || e.type === 'tp3').map((e) => e.type),
                ]);
                const tps = [...reached].map((t) => eventLabel(t as 'tp1' | 'tp2' | 'tp3'));
                // Для заявки в рынке показываем, сколько ещё не хватает цене до лимита.
                const live = liveOf(p);
                const gap = isPending && live != null ? limitGap(p, live) : 0;
                return (
                  <tr key={p.id} {...rowKeyProps(() => navigate(`/paper/${p.id}`), `Разбор позиции ${p.symbol}`)}>
                    <td className="sym">
                      <PairLink symbol={p.symbol} category={p.category} /><br />
                      <span className="muted">{p.category} · {p.interval}</span>
                    </td>
                    <td className={setupCls(p.direction)}>{p.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</td>
                    <td>
                      {fmt(p.entryPrice, 4)}
                      <br />
                      <span className="muted">
                        {isPending
                          ? `лимит · ${fmtTime(p.openedAt)}`
                          : p.status === 'cancelled'
                            ? `заявка · ${fmtTime(p.openedAt)}`
                            : `${p.entryKind === 'market' ? 'рынок' : 'лимит'} · ${fmtTime(p.filledAt ?? p.openedAt)}`}
                      </span>
                    </td>
                    <td>
                      {isPending ? (
                        <>
                          <span className="muted">цена {live == null ? '—' : fmt(live, 4)}</span>
                          <br />
                          <span className="muted">
                            {live == null
                              ? 'ждём котировку'
                              : gap > 0
                                ? `до лимита ${fmtPctAbs(gap * 100, 2)} ${p.direction === 'long' ? 'ниже' : 'выше'}`
                                : 'лимит в рынке'}
                          </span>
                        </>
                      ) : p.status === 'cancelled' ? (
                        <span className="muted">—</span>
                      ) : fmt(exit, 4)}
                    </td>
                    <td>
                      <b>{fmt(r.margin)} $</b>
                      {(isPending || p.status === 'cancelled') && <span className="muted"> (при исполнении)</span>}
                      <br />
                      <span className="muted">
                        номинал {fmtCompact(r.notional)} $ · ×{p.leverage}
                        <br />
                        риск стопа {fmtCompact(p.qty * Math.abs(p.entryPrice - p.stop))} $ · лимит ставки {fmt(p.stake)} $
                      </span>
                    </td>
                    <td className={r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}>
                      {isPending || p.status === 'cancelled' ? (
                        <span className="muted">{isPending ? 'нет позиции' : 'сделок не было'}</span>
                      ) : (
                        <>
                          {r.net >= 0 ? '+' : ''}{fmt(r.net)} $ ({fmtPct(r.netMarginPct, 1)})
                        </>
                      )}
                    </td>
                    <td>
                      {isPending && (
                        <>
                          Лимит в рынке
                          <br />
                          <span className="muted">в рынке {fmtDuration(now - p.openedAt)}</span>
                        </>
                      )}
                      {!isPending && p.status === 'open' && (
                        <>Открыта{tps.length > 0 ? ` · ${[...new Set(tps)].join(', ')}` : ''}</>
                      )}
                      {p.status === 'closed' && <>Закрыта · {closeLabel(p.closeReason)}</>}
                      {p.status === 'cancelled' && (
                        <>
                          Заявка снята{p.cancelReason === 'stale' ? ' · протухла' : ''}
                          <br />
                          <span className="muted">
                            висела {fmtDuration((p.closedAt ?? p.openedAt) - p.openedAt)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="act">
                      {p.status === 'open' && (
                        <button
                          className="btn btn-sm"
                          onClick={(e) => { e.stopPropagation(); closeManual(p.id, exit, Date.now()); }}
                          title={`Закрыть по текущей цене ${fmt(exit, 4)}`}
                        >Закрыть</button>
                      )}
                      {isPending && (
                        <button
                          className="btn btn-sm"
                          onClick={(e) => { e.stopPropagation(); cancelPending([{ id: p.id, reason: 'manual' }]); }}
                          title="Снять заявку, не дожидаясь касания лимита"
                        >Снять</button>
                      )}
                      <button className="btn btn-sm" onClick={(e) => erase(e, p.id, p.symbol)}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}

      <PaperAnalytics closed={closed.filter((p) => p.status === 'closed')} />

      <footer className="foot">
        Вход — это лимитная заявка по середине зоны, а не позиция: пока цена не дошла до лимита, сделки нет и P&L нулевой
        (иначе бумага рисовала бы «мгновенную прибыль», которой на бирже не бывает). Исполнение наступает, когда цена
        доходит до лимита; неисполненная заявка снимается вручную или сама через 24 ч. Открытые позиции переоцениваются
        по живым тикерам. TP1 фиксирует 70% позиции, TP2 — ещё 20%, остаток идёт до TP3; после TP1 стоп переносится в
        безубыток. P&L показан чистыми — за вычетом комиссии за круг (тейкер). P&L в $ = движение цены × количество и
        не зависит от плеча; проценты — к марже (номинал/плечо) и к ставке. Клик по строке — детальный разбор.
      </footer>
    </div>
  );
}
