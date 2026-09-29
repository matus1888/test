import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchKlines } from '../api/bybit';
import { usePaperPositions } from '../hooks/usePaper';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import {
  closeLabel,
  evaluatePosition,
  eventLabel,
  fillsFor,
  fmtDuration,
  fmtTime,
  liquidationPrice,
  limitGap,
  settleOpen,
  staleLimits,
  totalPnlOf,
  TP_FRACS,
  type PaperPosition,
} from '../lib/paper';
import { fmt, fmtCompact, fmtPct, fmtPctAbs } from '../lib/format';
import { effectiveCycleMs } from '../lib/klinePlan';
import StrategyChart from '../components/StrategyChart';
import Term from '../components/Term';
import PairLink from '../components/PairLink';
import type { TradePlan } from '../lib/tradePlan';
import { useConfirm } from '../components/Confirm';

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
  const { positions, closeManual, settle, fill, cancelPending, remove } = usePaperPositions();
  const [confirm, confirmDialog] = useConfirm();
  const pos = positions.find((p) => p.id === id);
  // «Сколько в позиции / сколько заявка в рынке» — тик раз в минуту.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  // Живая цена — из сокета (REST остаётся страховкой до первого кадра).
  const prices = useLivePrices(pos ? groupByCategory([pos]) : []);
  // MFE/MAE и авто-закрытие считаются по закрытым свечам, поэтому обновляемся
  // по закрытию интервала, а не каждые 30 секунд.
  const cycleMs = effectiveCycleMs(pos?.interval ?? '5', 60_000) || 60_000;
  const klines = useQuery({
    queryKey: pos ? ['kline', pos.category, pos.symbol, pos.interval, 200] : ['kline', 'none'],
    queryFn: () => fetchKlines(pos!.category, pos!.symbol, pos!.interval, 200),
    enabled: !!pos,
    staleTime: cycleMs,
    refetchInterval: cycleMs,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const candles = useMemo(() => klines.data ?? [], [klines.data]);
  const ev = pos ? evaluatePosition(pos, candles) : null;
  // Живая цена: для переоценки нужна, но пока сокета нет — честнее «—», чем цена входа.
  const livePrice = pos ? prices.get(`${pos.category}:${pos.symbol}`) ?? null : null;
  const live = livePrice ?? pos?.entryPrice ?? 0;

  // Материализация исполнения лимита, снятия протухшей заявки и авто-закрытия.
  // Пока заявка в рынке, позиции нет — и P&L на странице нулевой.
  useEffect(() => {
    if (!pos) return;
    if (pos.status === 'pending') {
      // `now` по умолчанию берётся внутри движка: пока заявка висит, она либо
      // исполнилась (по истории свечей или по живой цене), либо протухла.
      fill(fillsFor([pos], () => candles, () => livePrice));
      if (staleLimits([pos]).length > 0) cancelPending([{ id: pos.id, reason: 'stale' }]);
      return;
    }
    if (pos.status !== 'open' || candles.length === 0) return;
    const info = settleOpen(pos, candles);
    if (info) settle([{ id: pos.id, info }]);
  }, [pos, candles, livePrice, fill, cancelPending, settle]);

  if (!pos) {
    return (
      <div className="page">
        <Link to="/paper" className="back">← Назад к портфелю</Link>
        <p className="state err">Позиция не найдена — возможно, удалена.</p>
      </div>
    );
  }

  const isPending = pos.status === 'pending';
  // Заявка без исполнения (висит или снята): позиции не было — ход цены не в счёт.
  const noFill = isPending || pos.status === 'cancelled';
  const exit = pos.status === 'open' ? live : (pos.closePrice ?? pos.entryPrice);
  const r = totalPnlOf(pos, exit);
  const exitTime = pos.status === 'open' ? now : (pos.closedAt ?? pos.filledAt ?? pos.openedAt);
  const startTime = pos.filledAt ?? pos.openedAt;
  const decimals = pos.entryPrice < 1 ? 5 : 2;
  // Оценка ликвидации для изолированной маржи. При плече 1× лонг
  // ликвидировать нельзя (0 — недостижимо), линию на графике не рисуем.
  const liq = liquidationPrice(pos);
  const liqLine = liq != null && liq > 0 ? liq : null;

  const persistedLegs = new Set((pos.legs ?? []).map((l) => l.reason));
  const legText = (reason: 'tp1' | 'tp2', price: number, frac: number) =>
    `Частичный выход ${eventLabel(reason)} (${Math.round(frac * 100)}%) по ${fmt(price, decimals)}`;
  const placedEvent = {
    time: pos.openedAt,
    text: `Заявка выставлена: лимит ${pos.direction === 'long' ? 'покупка' : 'продажа'} по ${fmt(pos.entryPrice, decimals)}`
      + ` · риск ${fmt(pos.riskMoney ?? 0)} $ ×${pos.leverage} · позиции ещё нет`,
  };
  const fillEvent = {
    time: startTime,
    text: pos.entryKind === 'market'
      ? `Вход по рынку: ${pos.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'} ${fmt(pos.entryPrice, decimals)} · `
        + `исполнено сразу по текущей цене · риск ${fmt(pos.riskMoney ?? 0)} $ ×${pos.leverage}`
      : `Вход по лимиту: ${pos.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'} ${fmt(pos.entryPrice, decimals)} · ставка ${fmt(pos.stake)} $ ×${pos.leverage}`,
  };
  const timeline: { time: number; text: string }[] = [
    // Пока заявка висит или снята — в ленте только постановка и снятие: входа не было.
    // После исполнения видно оба события, если они не совпали по времени (обычно заявка
    // стоит минуты, а потом задевается). Legacy-позиции: только вход, как раньше.
    ...(noFill || (pos.filledAt != null && pos.filledAt > pos.openedAt) ? [placedEvent] : []),
    ...(noFill ? [] : [fillEvent]),
    ...(pos.legs ?? []).map((l) => ({ time: l.time, text: legText(l.reason, l.price, l.frac) })),
    ...(ev?.events
      .filter((e) => !((e.type === 'tp1' || e.type === 'tp2') && persistedLegs.has(e.type)))
      .map((e) => ({
        time: e.time,
        text: e.type === 'stop'
          ? `Задет стоп по ${fmt(e.price, decimals)}`
          : e.type === 'breakeven'
            ? `Сработал безубыток по ${fmt(e.price, decimals)}`
            : e.type === 'liq'
              ? `Ликвидация: позиция закрыта принудительно по ${fmt(e.price, decimals)}`
              : e.type === 'tp1' || e.type === 'tp2'
                ? legText(e.type, e.price, TP_FRACS[e.type])
                : `Достигнут ${eventLabel(e.type)} по ${fmt(e.price, decimals)}`,
      })) ?? []),
  ];
  if (pos.status === 'closed') {
    timeline.push({ time: pos.closedAt ?? startTime, text: `Закрыта (${closeLabel(pos.closeReason)}) по ${fmt(pos.closePrice ?? pos.entryPrice, decimals)}` });
  }
  if (pos.status === 'cancelled') {
    timeline.push({
      time: pos.closedAt ?? pos.openedAt,
      text: pos.cancelReason === 'stale'
        ? 'Заявка снята: не исполнилась за 24 ч, сетап протух'
        : 'Заявка снята вручную — сделки не было',
    });
  }
  timeline.sort((a, b) => a.time - b.time);

  const erase = async () => {
    const ok = await confirm({
      title: 'Удалить запись?',
      text: `Запись по ${pos.symbol} исчезнет из журнала.`,
      ok: 'Удалить',
      danger: true,
    });
    if (ok) {
      remove(pos.id);
      navigate('/paper');
    }
  };

  return (
    <div className="page">
      {confirmDialog}
      <Link to="/paper" className="back">← Назад к портфелю</Link>
      <header className="top">
        <div>
          <h1>
            <PairLink symbol={pos.symbol} category={pos.category} withText />{' '}
            <span className={pos.direction === 'long' ? 'pos' : 'neg'}>{pos.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}</span>{' '}
            <span className="muted">· {pos.category} · {pos.interval}</span>
          </h1>
          <p className="sub">
            {isPending
              ? <>Заявка в рынке · лимит выставлен {fmtTime(pos.openedAt)}</>
              : pos.status === 'cancelled'
                ? <>Заявка снята без исполнения{pos.closedAt ? ` · ${fmtTime(pos.closedAt)}` : ''}</>
                : pos.status === 'open'
                  ? <>Открыта · {pos.entryKind === 'market' ? 'вход по рынку' : 'вход'} {fmtTime(startTime)}</>
                  : <>Закрыта · {closeLabel(pos.closeReason)} · вход {fmtTime(startTime)}</>}
          </p>
        </div>
        <div className="controls">
          {pos.status === 'open' && (
            <button className="btn" onClick={() => closeManual(pos.id, live, Date.now())}>
              Закрыть по рынку ({fmt(live, decimals)})
            </button>
          )}
          {isPending && (
            <button className="btn" onClick={() => cancelPending([{ id: pos.id, reason: 'manual' }])}>
              Снять заявку
            </button>
          )}
          <button className="btn btn-danger" onClick={erase}>Удалить</button>
        </div>
      </header>

      <section className="cards">
        <div className="card">
          <h3><Term t="position" label="Вход" /></h3>
          <div className="lvl">
            <span>{pos.entryKind === 'market' ? 'Цена входа (рынок)' : 'Цена лимита'}</span>
            <b>{fmt(pos.entryPrice, decimals)}</b>
          </div>
          {pos.entryKind === 'market' && (
            <p className="state">
              Исполнено сразу по текущей котировке, без ожидания отката. Проскальзывание в бумаге
              не учитывается: на бирже реальная цена входа была бы чуть хуже.
            </p>
          )}
          {isPending && (
            <div className="lvl">
              <span>Цена сейчас</span>
              <b>
                {livePrice == null ? '—' : (
                  <>
                    {fmt(livePrice, decimals)}{' '}
                    <span className="muted">
                      (до лимита {fmtPctAbs(limitGap(pos, livePrice) * 100, 2)} {pos.direction === 'long' ? 'ниже' : 'выше'})
                    </span>
                  </>
                )}
              </b>
            </div>
          )}
          <div className="lvl"><span><Term t="stake" label="Ставка" /></span><b>{fmt(pos.stake)} $</b></div>
          <div className="lvl"><span><Term t="leverage" label="Плечо" /></span><b>×{pos.leverage}</b></div>
          <div className="lvl"><span><Term t="qty" label="Количество" /></span><b>{fmt(pos.qty, 4)}</b></div>
          <div className="lvl"><span><Term t="confidence" label="Уверенность" /></span><b>{pos.confidence}%</b></div>
        </div>
        <div className="card">
          <h3><Term t="pnl" label="Итог" /></h3>
          {isPending ? (
            <>
              <div className="lvl"><span>Позиция</span><b>ещё не открыта</b></div>
              <div className="lvl"><span>Заявка в рынке</span><b>{fmtDuration(now - pos.openedAt)}</b></div>
              <div className="lvl"><span>P&L</span><b className="muted">0 $ — сделки не было</b></div>
              <p className="state">
                Заявка ждёт касания лимита {fmt(pos.entryPrice, decimals)}. До этого момента движения цены не входят
                в результат: так бумага повторяет биржевую механику, где позиции тоже ещё нет.
              </p>
            </>
          ) : pos.status === 'cancelled' ? (
            <>
              <div className="lvl"><span>Позиция</span><b>не открывалась</b></div>
              <div className="lvl"><span>Заявка висела</span><b>{fmtDuration((pos.closedAt ?? pos.openedAt) - pos.openedAt)}</b></div>
              <div className="lvl"><span>P&L</span><b className="muted">0 $ — сделки не было</b></div>
              <p className="state">
                Заявка по {fmt(pos.entryPrice, decimals)} снята {pos.cancelReason === 'stale'
                  ? 'сама: за 24 часа лимит не задели, сетап протух'
                  : 'вручную, не дожидаясь касания'}
                . Комиссии нет — на бирже заявку без исполнения тоже не списывают.
              </p>
            </>
          ) : (
            <>
              <div className="lvl"><span>{pos.status === 'open' ? 'Текущая цена' : 'Цена выхода'}</span><b>{fmt(exit, decimals)}</b></div>
              <div className="lvl"><span>P&L, $</span><b className={r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : ''}>{r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}</b></div>
              {(pos.legs ?? []).length > 0 && (
                <div className="lvl"><span>Зафиксировано частями</span><b className="pos">+{fmt(r.booked)}</b></div>
              )}
              <div className="lvl"><span><Term t="fee" label="Комиссия ~" /></span><b>−{fmt(r.fee)}</b></div>
              <div className="lvl"><span>P&L net, $</span><b className={r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}>{r.net >= 0 ? '+' : ''}{fmt(r.net)}</b></div>
              <div className="lvl"><span><Term t="margin" label="P&L net, % к марже" /></span><b>{fmtPct(r.netMarginPct, 1)}</b></div>
              <div className="lvl"><span>P&L net, % к ставке</span><b>{fmtPct(r.netPct, 1)}</b></div>
              <div className="lvl"><span><Term t="rMultiple" label="R-мультипл net" /></span><b>{fmt(r.netR, 2)}R</b></div>
              <div className="lvl"><span><Term t="holding" label="Время в позиции" /></span><b>{fmtDuration(exitTime - startTime)}</b></div>
              <div className="lvl"><span><Term t="notional" label="Номинал / маржа" /></span><b>{fmtCompact(r.notional)} $ / {fmt(r.margin)} $</b></div>
            </>
          )}
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
          <div className="lvl"><span>MFE</span><b className="pos">{!noFill && ev ? fmt(ev.mfeR, 1) : '—'}{noFill ? '' : 'R'}</b></div>
          <div className="lvl"><span>MAE</span><b className="neg">{!noFill && ev ? fmt(ev.maeR, 1) : '—'}{noFill ? '' : 'R'}</b></div>
          <p className="state">MFE — лучший ход в твою пользу, MAE — худшая просадка, в единицах риска. Считаются от момента исполнения лимита.</p>
          {ev?.partial && <p className="state">История свечей короче жизни позиции — ранние события могли не попасть в разбор.</p>}
        </div>
      </section>

      {candles.length > 0 && (
        <StrategyChart
          candles={candles}
          plan={planForChart(pos, Math.max(...candles.map((c) => c.high)), Math.min(...candles.map((c) => c.low)))}
          markers={[
            isPending
              ? { time: pos.openedAt, label: 'Лимит', color: '#3b82f6' }
              : pos.status === 'cancelled'
                // Снятой заявке показываем, сколько она висела в рынке: точки входа не было.
                ? { time: pos.closedAt ?? pos.openedAt, label: 'Снята', color: '#94a3b8' }
                : { time: startTime, label: 'Вход', color: '#3b82f6' },
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
        Номинал позиции: {fmtCompact(pos.qty * pos.entryPrice)}. P&L в $ = движение цены × количество и не зависит от плеча; проценты — к марже (номинал/плечо). Линия LIQ — оценка ликвидации для изолированной маржи, не точная цена биржи. TP1 фиксирует 70%, TP2 — 20%, после TP1 стоп в безубытке. Вход — лимит по середине зоны: позиция и её P&L появляются только после касания лимита.
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
