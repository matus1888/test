import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchKlines, fetchTickers } from '../api/bybit';
import { usePaperPositions } from '../hooks/usePaper';
import {
  closeLabel,
  evaluatePosition,
  eventLabel,
  fmtDuration,
  fmtTime,
  liquidationPrice,
  settleOpen,
  totalPnlOf,
  TP_FRACS,
  type PaperPosition,
} from '../lib/paper';
import { fmt, fmtCompact, fmtPct } from '../lib/format';
import StrategyChart from '../components/StrategyChart';
import Term from '../components/Term';
import type { TradePlan } from '../lib/tradePlan';

/** Синтетический план из параметров входа — чтобы показать уровни на графике. */
function planForChart(pos: PaperPosition, candlesHigh: number, candlesLow: number): TradePlan {
  return {
    direction: pos.direction,
    confidence: pos.confidence,
    regime: '',
    horizon: '',
    price: pos.entryPrice,
    atr: Math.abs(pos.entryPrice - pos.stop) / 1.8,
    ema20: pos.entryPrice,
    ema50: pos.entryPrice,
    recentHigh: candlesHigh,
    recentLow: candlesLow,
    entryLow: pos.entryLow,
    entryHigh: pos.entryHigh,
    entryMid: (pos.entryLow + pos.entryHigh) / 2,
    stop: pos.stop,
    tp1: pos.tp1,
    tp2: pos.tp2,
    tp3: pos.tp3,
    riskDist: Math.abs(pos.entryPrice - pos.stop),
    rrTp1: 1,
    rrTp2: 2,
    rrTp3: 3,
    summary: '',
    setup: '',
    risks: [],
    invalidation: [],
    checklist: [],
  };
}

export default function PaperDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { positions, closeManual, settle, remove } = usePaperPositions();
  const pos = positions.find((p) => p.id === id);

  const tickers = useQuery({
    queryKey: ['tickers', pos?.category ?? 'linear'],
    queryFn: () => fetchTickers(pos!.category),
    enabled: !!pos,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const klines = useQuery({
    queryKey: pos ? ['kline', pos.category, pos.symbol, pos.interval, 200] : ['kline', 'none'],
    queryFn: () => fetchKlines(pos!.category, pos!.symbol, pos!.interval, 200),
    enabled: !!pos,
    staleTime: 30_000,
    retry: 1,
  });

  const candles = useMemo(() => klines.data ?? [], [klines.data]);
  const ev = pos ? evaluatePosition(pos, candles) : null;

  // Материализация авто-закрытия
  useEffect(() => {
    if (!pos || pos.status !== 'open' || candles.length === 0) return;
    const info = settleOpen(pos, candles);
    if (info) settle([{ id: pos.id, info }]);
  }, [pos, candles, settle]);

  if (!pos) {
    return (
      <div className="page">
        <Link to="/paper" className="back">← Назад к портфелю</Link>
        <p className="state err">Позиция не найдена — возможно, удалена.</p>
      </div>
    );
  }

  const live = tickers.data?.find((t) => t.symbol === pos.symbol)?.lastPrice ?? pos.entryPrice;
  const exit = pos.status === 'open' ? live : (pos.closePrice ?? pos.entryPrice);
  const r = totalPnlOf(pos, exit);
  const exitTime = pos.status === 'open' ? Date.now() : (pos.closedAt ?? pos.openedAt);
  const decimals = pos.entryPrice < 1 ? 5 : 2;
  // Оценка ликвидации для изолированной маржи. При плече 1× лонг
  // ликвидировать нельзя (0 — недостижимо), линию на графике не рисуем.
  const liq = liquidationPrice(pos);
  const liqLine = liq != null && liq > 0 ? liq : null;

  const persistedLegs = new Set((pos.legs ?? []).map((l) => l.reason));
  const legText = (reason: 'tp1' | 'tp2', price: number, frac: number) =>
    `Частичный выход ${eventLabel(reason)} (${Math.round(frac * 100)}%) по ${fmt(price, decimals)}`;
  const timeline: { time: number; text: string }[] = [
    { time: pos.openedAt, text: `Открыта: ${pos.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'} по ${fmt(pos.entryPrice, decimals)} · ставка ${fmt(pos.stake)} $ ×${pos.leverage}` },
    ...(pos.legs ?? []).map((l) => ({ time: l.time, text: legText(l.reason, l.price, l.frac) })),
    ...(ev?.events
      .filter((e) => !((e.type === 'tp1' || e.type === 'tp2') && persistedLegs.has(e.type)))
      .map((e) => ({
        time: e.time,
        text: e.type === 'stop'
          ? `Задет стоп по ${fmt(e.price, decimals)}`
          : e.type === 'breakeven'
            ? `Сработал безубыток по ${fmt(e.price, decimals)}`
            : e.type === 'tp1' || e.type === 'tp2'
              ? legText(e.type, e.price, TP_FRACS[e.type])
              : `Достигнут ${eventLabel(e.type)} по ${fmt(e.price, decimals)}`,
      })) ?? []),
  ];
  if (pos.status === 'closed') {
    timeline.push({ time: pos.closedAt ?? pos.openedAt, text: `Закрыта (${closeLabel(pos.closeReason)}) по ${fmt(pos.closePrice ?? pos.entryPrice, decimals)}` });
  }
  timeline.sort((a, b) => a.time - b.time);

  const erase = () => {
    if (window.confirm(`Удалить позицию ${pos.symbol} из журнала?`)) {
      remove(pos.id);
      navigate('/paper');
    }
  };

  return (
    <div className="page">
      <Link to="/paper" className="back">← Назад к портфелю</Link>
      <header className="top">
        <div>
          <h1>
            {pos.symbol} <span className={pos.direction === 'long' ? 'pos' : 'neg'}>{pos.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</span>{' '}
            <span className="muted">· {pos.category} · {pos.interval}</span>
          </h1>
          <p className="sub">
            {pos.status === 'open' ? 'Открыта' : `Закрыта · ${closeLabel(pos.closeReason)}`} · вход {fmtTime(pos.openedAt)}
          </p>
        </div>
        <div className="controls">
          {pos.status === 'open' && (
            <button className="btn" onClick={() => closeManual(pos.id, live, Date.now())}>
              Закрыть по рынку ({fmt(live, decimals)})
            </button>
          )}
          <button className="btn btn-danger" onClick={erase}>Удалить</button>
        </div>
      </header>

      <section className="cards">
        <div className="card">
          <h3><Term t="position" label="Вход" /></h3>
          <div className="lvl"><span>Цена</span><b>{fmt(pos.entryPrice, decimals)}</b></div>
          <div className="lvl"><span><Term t="stake" label="Ставка" /></span><b>{fmt(pos.stake)} $</b></div>
          <div className="lvl"><span><Term t="leverage" label="Плечо" /></span><b>×{pos.leverage}</b></div>
          <div className="lvl"><span><Term t="qty" label="Количество" /></span><b>{fmt(pos.qty, 4)}</b></div>
          <div className="lvl"><span><Term t="confidence" label="Уверенность" /></span><b>{pos.confidence}%</b></div>
        </div>
        <div className="card">
          <h3><Term t="pnl" label="Итог" /></h3>
          <div className="lvl"><span>{pos.status === 'open' ? 'Текущая цена' : 'Цена выхода'}</span><b>{fmt(exit, decimals)}</b></div>
          <div className="lvl"><span>P&L, $</span><b className={r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : ''}>{r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}</b></div>
          {(pos.legs ?? []).length > 0 && (
            <div className="lvl"><span>Зафиксировано частями</span><b className="pos">+{fmt(r.booked)}</b></div>
          )}
          <div className="lvl"><span><Term t="fee" label="Комиссия ~" /></span><b>−{fmt(r.fee)}</b></div>
          <div className="lvl"><span>P&L net, $</span><b className={r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}>{r.net >= 0 ? '+' : ''}{fmt(r.net)}</b></div>
          <div className="lvl"><span>P&L net, % к ставке</span><b>{fmtPct(r.netPct, 1)}</b></div>
          <div className="lvl"><span><Term t="rMultiple" label="R-мультипл net" /></span><b>{fmt(r.netR, 2)}R</b></div>
          <div className="lvl"><span><Term t="holding" label="Время в позиции" /></span><b>{fmtDuration(exitTime - pos.openedAt)}</b></div>
        </div>
        <div className="card">
          <h3>Уровни плана</h3>
          <LevelRow label="Зона входа" gloss="entryZone" value={`${fmt(pos.entryLow, decimals)}–${fmt(pos.entryHigh, decimals)}`} />
          <LevelRow label="Стоп" gloss="stop" value={fmt(pos.stop, decimals)} cls="neg" hit={ev?.events.some((e) => e.type === 'stop')} />
          {(['tp1', 'tp2', 'tp3'] as const).map((k, i) => (
            <LevelRow
              key={k}
              label={`TP${i + 1}`}
              gloss="tp"
              value={fmt(pos[k], decimals)}
              cls="pos"
              hit={ev?.events.some((e) => e.type === k)}
            />
          ))}
          <LevelRow
            label="Ликвидация ~"
            gloss="liq"
            value={liq == null ? '—' : liq <= 0 ? '0 (1× — недостижима)' : fmt(liq, decimals)}
            cls="neg"
          />
        </div>
        <div className="card">
          <h3>Движение цены</h3>
          <div className="lvl"><span>MFE</span><b className="pos">{ev ? fmt(ev.mfeR, 1) : '…'}R</b></div>
          <div className="lvl"><span>MAE</span><b className="neg">{ev ? fmt(ev.maeR, 1) : '…'}R</b></div>
          <p className="state">MFE — лучший ход в твою пользу, MAE — худшая просадка, в единицах риска.</p>
          {ev?.partial && <p className="state">История свечей короче жизни позиции — ранние события могли не попасть в разбор.</p>}
        </div>
      </section>

      {candles.length > 0 && (
        <StrategyChart
          candles={candles}
          plan={planForChart(pos, Math.max(...candles.map((c) => c.high)), Math.min(...candles.map((c) => c.low)))}
          markers={[
            { time: pos.openedAt, label: 'Вход', color: '#3b82f6' },
            ...(pos.status === 'closed' && pos.closedAt != null
              ? [{ time: pos.closedAt, label: 'Выход', color: '#f59e0b' }]
              : []),
          ]}
          liqPrice={liqLine}
          decimals={decimals}
        />
      )}

      <section className="detail">
        <h3>Лента событий</h3>
        <ul className="timeline">
          {timeline.map((t, i) => (
            <li key={i}><b>{fmtTime(t.time)}</b> — {t.text}</li>
          ))}
        </ul>
      </section>

      <footer className="foot">
        Номинал позиции: {fmtCompact(pos.qty * pos.entryPrice)}. P&L считается от плеча: движение цены × количество, чистыми за вычетом комиссии за круг (тейкер). TP1 фиксирует 70%, TP2 — 20%, после TP1 стоп в безубытке. Линия LIQ — оценка ликвидации для изолированной маржи, не точная цена биржи.
      </footer>
    </div>
  );
}

function LevelRow({ label, gloss, value, cls, hit }: { label: string; gloss: string; value: string; cls?: string; hit?: boolean }) {
  return (
    <div className="lvl">
      <span><Term t={gloss} label={label} />{hit ? ' ✓' : ''}</span>
      <b className={cls}>{value}</b>
    </div>
  );
}
