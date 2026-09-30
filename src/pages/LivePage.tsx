import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  INTERVALS,
  INTERVAL_LABELS,
  type Interval,
} from '../api/bybit';
import { useKlines } from '../hooks/useMarket';
import {
  cancelOrder,
  clearCredentials,
  loadCredentials,
  type ApiCredentials,
} from '../api/privateApi';
import { closeAllReal, closeReal, getInstrument, moveStopToBreakeven, openReal, openRealMarket, placeLadder, planLadder } from '../api/live';
import { computeMetrics } from '../lib/metrics';
import { buildTradePlan, type TradePlan } from '../lib/tradePlan';
import { useSessionState } from '../hooks/useSessionState';
import { useApiAccount } from '../hooks/useApiAccount';
import { parseLiveLink } from '../lib/tradeMode';
import { fmt, fmtCompact } from '../lib/format';
import { setupCls, setupText } from '../lib/ui';
import Term from '../components/Term';
import PairLink from '../components/PairLink';
import EnvBadge from '../components/EnvBadge';
import WsBadge from '../components/WsBadge';
import { useConfirm } from '../components/Confirm';

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;

/** Похоже на тикер Bybit — иначе в поле символа нечего превращать в ссылку на биржу. */
const isTicker = (v: string) => /^[A-Z0-9]{5,20}$/.test(v);

/** Реальная торговля через API Bybit (сеть — та, что в сохранённых ключах). */
export default function LivePage() {
  const [stored] = useState<ApiCredentials | null>(() => loadCredentials());
  // Ключи могут смениться на /api, пока страница открыта — берём актуальные из хука счёта.
  const api = useApiAccount();
  const cred = api.cred ?? stored;
  // Предзаполнение из ссылки «Реальный вход →» в скринере/плане: /live?symbol=…&interval=…
  const [link] = useSearchParams();
  const fromLink = useMemo(() => parseLiveLink(`?${link.toString()}`), [link]);
  // Вид входа из ссылки «Реальный →» (по рынку) в скринере: &kind=market.
  const linkKind = useMemo(() => (new URLSearchParams(link.toString()).get('kind') === 'market' ? 'market' : 'limit'), [link]);
  const [symbol, setSymbol] = useState(fromLink.symbol);
  const isTf = (v: unknown): v is Interval => typeof v === 'string' && (INTERVALS as string[]).includes(v);
  const [interval, setLiveInterval] = useSessionState<Interval>(
    'live:interval',
    isTf(fromLink.interval) ? fromLink.interval : '5',
    isTf,
  );
  const [deposit] = useSessionState<number>('symbol:deposit', 1000, isPositiveNumber);
  const [riskPct] = useSessionState<number>('symbol:riskPct', 1, isPositiveNumber);
  const [lev] = useSessionState<number>('paper:leverage', 3, isPositiveNumber);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [entryKind, setEntryKind] = useState<'limit' | 'market'>(linkKind);
  const [actionError, setActionError] = useState<string | null>(null);
  // ReactNode, а не строка: в уведомлениях символ должен быть ссылкой на биржу (PairLink).
  const [notice, setNotice] = useState<ReactNode>(null);
  const [confirm, confirmDialog] = useConfirm();
  // Вход выставлен, лесенка TP ждёт появления позиции (reduce-only ставится только
  // после исполнения входа — 110017). Авто-выставление в useEffect ниже + ручная кнопка.
  const [pendingLadder, setPendingLadder] = useState<null | {
    symbol: string; direction: 'long' | 'short'; qty: number; tp1: number; tp2: number; tp3: number;
  }>(null);

  const testnet = !!cred?.testnet;
  const sym = symbol.trim().toUpperCase();

  // Портфель, ордера и баланс — из общего снимка счёта: он живой (приватный WebSocket),
  // поэтому вместо трёх запросов каждые 12 с идут события по мере сделок.
  const account = api.account;
  const balanceQ = { isError: api.state === 'error', error: api.error, data: account?.wallet ?? null };
  const positionsQ = { isError: api.state === 'error', error: api.error };
  const ordersQ = { isError: api.state === 'error', error: api.error };
  // План по СВЕЧАМ ИЗ ОБЩЕГО КЭША kline: тот же хук `useKlines`, что у скринера,
  // тот же ключ ['kline', category, symbol, interval, 200]. Раньше /live делал свой
  // fetchKlines и пересчитывал план по другой порции свечей — из-за этого сетап из
  // скринера «мигал» и на /live оказывался направленным или наоборот (данные были
  // из разных источников). Общий кэш = один источник данных для обеих страниц.
  const [kl] = useKlines('linear', sym ? [sym] : [], interval, 200, {
    enabled: sym.length > 0,
    refreshMs: 60_000, // цикл обновления как у скринера (на 5m — 75 с)
    perCycle: 1,
  });
  const plan: TradePlan | null = useMemo(() => {
    const candles = kl?.candles ?? [];
    if (candles.length < 55) return null;
    const m = computeMetrics(candles);
    return m ? buildTradePlan(candles, m, 'linear', null, interval) : null;
  }, [kl?.candles, interval]);
  const planLoading = !!kl?.fetching || (!kl?.candles.length && !!kl?.loading);
  const canTrade = testnet || confirmed;

  // Ограничения биржи по символу (шаг количества, минимальный номинал) — один раз на символ.
  const instQ = useQuery({
    queryKey: ['live', 'inst', sym, cred?.testnet ?? false],
    queryFn: () => getInstrument(cred as ApiCredentials, 'linear', sym),
    enabled: !!cred && sym.length > 0,
    staleTime: 900_000,
    retry: false,
  });

  // Флаг «лесенка уже ставится»: реакция на каждое живое изменение позиции не должна
  // слать дубли ордеров, пока первый вызов в полёте.
  const ladderBusyRef = useRef(false);

  const reload = useCallback(() => {
    void api.reload();
  }, [api]);

const doOpen = async () => {
    if (!cred || !plan || !canTrade) return;
    if (plan.direction !== 'long' && plan.direction !== 'short') return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const riskMoney = deposit * (riskPct / 100);
      const res = entryKind === 'market'
        ? await openRealMarket(cred, { category: 'linear', symbol: sym, plan, riskMoney, leverage: lev })
        : await openReal(cred, { category: 'linear', symbol: sym, plan, riskMoney, leverage: lev });
      // Лесенка TP ставится ПОСЛЕ исполнения входа (позиция появилась) — см. useEffect ниже.
      setPendingLadder({ symbol: sym, direction: plan.direction, qty: res.qty, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3 });
      setNotice(
        <>
          <PairLink symbol={sym} category="linear" />{' '}
          {plan.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}: {entryKind === 'market' ? 'рыночный' : 'лимитный'} вход {res.entryOrder.orderId}, qty {res.qty}, маржа ~{fmt(res.margin, 0)} $.
          {' '}Лесенка TP1/TP2/TP3 выставится автоматически, когда вход исполнится и позиция откроется.
        </>,
      );
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Авто-выставление лесенки: вход исполнился (позиция по символу появилась) →
  // ставим reduce-only TP1/TP2/TP3. Срабатывает на событиях приватного сокета (живые позиции).
  useEffect(() => {
    if (!cred || !pendingLadder || ladderBusyRef.current) return;
    const p = account?.positions.find(
      (pp) => pp.symbol === pendingLadder.symbol && pp.side === (pendingLadder.direction === 'long' ? 'Buy' : 'Sell'),
    );
    if (!p) return; // позиции ещё нет — вход висит лимитом
    ladderBusyRef.current = true;
    (async () => {
      try {
        const placed = await placeLadder(cred, {
          category: 'linear', symbol: pendingLadder.symbol, qty: p.size,
          tps: [pendingLadder.tp1, pendingLadder.tp2, pendingLadder.tp3],
          direction: pendingLadder.direction, positionIdx: p.positionIdx,
        });
        setNotice(
          <>
            <PairLink symbol={pendingLadder.symbol} category="linear" />: вход исполнился — лесенка TP1/TP2/TP3 выставлена
            {' '}({placed.length} reduce-only лимиток).
          </>,
        );
        setPendingLadder(null);
        reload();
      } catch (e) {
        setActionError(`Лесенка TP не выставилась: ${e instanceof Error ? e.message : String(e)}`);
        // Оставляем pendingLadder: кнопка «Выставить TP» в таблице позиций позволит повторить.
      } finally {
        ladderBusyRef.current = false;
      }
    })();
  }, [account?.positions, cred, pendingLadder, reload]);

  const doClose = async (s: string, direction: 'long' | 'short') => {
    if (!cred || !canTrade) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      await closeReal(cred, { category: 'linear', symbol: s, direction });
      setPendingLadder((prev) => (prev?.symbol === s ? null : prev));
      setNotice(<><PairLink symbol={s} category="linear" />: закрыт по рынку</>);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doCloseAll = async () => {
    if (!cred || !canTrade || positions.length === 0) return;
    const ok = await confirm({
      title: 'Закрыть все позиции по рынку?',
      text: `Позиций: ${positions.length}. Действие отправляет настоящие ордера на ${testnet ? 'тестнет' : 'мейннет'} Bybit.`,
      ok: 'Закрыть всё',
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const list = positions.map((p) => ({
        symbol: p.symbol,
        direction: p.side === 'Buy' ? 'long' as const : 'short' as const,
        positionIdx: p.positionIdx,
      }));
      const res = await closeAllReal(cred, list);
      const failed = res.failed.length > 0
        ? ` · не закрыты: ${res.failed.map((f) => `${f.symbol} (${f.error.slice(0, 60)})`).join(', ')}`
        : '';
      setPendingLadder(null);
      setNotice(`${testnet ? 'Тестнет: ' : ''}закрыто ${res.ok} из ${list.length} позиций${failed}`);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doBreakeven = async (s: string, entry: number) => {
    if (!cred || !canTrade) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      await moveStopToBreakeven(cred, { category: 'linear', symbol: s, entryPrice: entry });
      setNotice(<><PairLink symbol={s} category="linear" />: стоп перенесён в безубыток</>);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Ручная постановка лесенки на уже открытую позицию (если авто-выставление не сработало). */
  const doPlaceLadder = async (s: string, direction: 'long' | 'short', qty: number) => {
    if (!cred || !plan) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const placed = await placeLadder(cred, {
        category: 'linear', symbol: s, qty,
        tps: [plan.tp1, plan.tp2, plan.tp3],
        direction,
      });
      setNotice(<><PairLink symbol={s} category="linear" />: лесенка TP1/TP2/TP3 выставлена ({placed.length} reduce-only лимиток)</>);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doCancelOrder = async (orderId: string, symbol: string) => {
    if (!cred) return;
    setActionError(null);
    try {
      await cancelOrder(cred, 'linear', orderId, symbol);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!cred) {
    return (
      <div className="page">
        {confirmDialog}
        <Link to="/" className="back">← Назад к скринеру</Link>
        <p className="state">Сначала подключи API-ключи на странице <Link to="/api">/api</Link> (тестнет — безопаснее).</p>
      </div>
    );
  }

  const riskMoney = deposit * (riskPct / 100);
  const previewQty = plan && plan.riskDist > 0 ? riskMoney / plan.riskDist : 0;
  const previewMargin = plan ? (previewQty * plan.entryMid) / lev : 0;
  // Пред-полётная проверка лесенки: показывает минимальный размер до отправки ордеров.
  const ladder = plan && instQ.data ? planLadder(instQ.data, plan.entryMid, riskMoney, plan.riskDist) : null;
  const ladderProblems = ladder?.problems ?? [];
  const minDepositPct = ladder && deposit > 0 && ladder.minRisk > 0
    ? (ladder.minRisk / deposit) * 100
    : null;
  const positions = account?.positions ?? [];
  const orders = account?.orders ?? [];
  const unreal = positions.reduce((a, p) => a + p.unrealisedPnl, 0);

  return (
    <div className="page">
      {confirmDialog}
      <Link to="/" className="back">← Назад к скринеру</Link>

      <header className="top">
        <div>
          <h1>Реальная торговля <EnvBadge kind="real" label="РЕАЛЬНЫЕ ДЕНЬГИ" title="Здесь отправляются настоящие ордера — единственное место в приложении, где это происходит" /></h1>
          <p className="sub">
            Единственная страница, где уходят реальные ордера: план по символу → лимитный вход со стопом → лесенка TP1/TP2/TP3.
            {' '}Виртуальные входы — в скринере и на странице символа в режиме «Бумага», портфель — <Link to="/paper">/paper</Link>.
          </p>
          <p className="sub">
            Сеть: <b className={testnet ? '' : 'neg'}>{testnet ? 'ТЕСТНЕТ' : 'МЕЙННЕТ'}</b> · equity{' '}
            {balanceQ.data ? `${fmtCompact(balanceQ.data.totalEquity)} $` : '…'} · свободно{' '}
            {balanceQ.data ? `${fmtCompact(balanceQ.data.totalAvailableBalance)} $` : '…'} · позиций {positions.length}
            {positions.length > 0 ? ` · uP&L ${fmt(unreal)} $` : ''}
            {' '}<WsBadge state={api.ws} testnet={testnet} />
          </p>
        </div>
        <div className="controls">
          {testnet && <span className="muted">тест — риска нет</span>}
          {!testnet && !confirmed && (
            <label className="state err-note"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Я понимаю: это реальные деньги</label>
          )}
          <button className="btn" onClick={() => { clearCredentials(); window.location.hash = '#/'; }}>Удалить ключи</button>
        </div>
      </header>

      {actionError && <p className="state err">{actionError}</p>}
      {notice && <p className="state pos">{notice}</p>}

      <section className="cards">
        <div className="card">
          <h3>Открыть реальный ордер из плана</h3>
          <label>Символ
            <input name="liveSymbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="BTCUSDT" />
          </label>
          {isTicker(sym) && (
            <p className="state">
              Торговля на бирже: <PairLink symbol={sym} category="linear" withText />
            </p>
          )}
          <label>Таймфрейм
            <select name="liveInterval" value={interval} onChange={(e) => setLiveInterval(e.target.value as Interval)}>
              {INTERVALS.map((i) => <option key={i} value={i}>{INTERVAL_LABELS[i]}</option>)}
            </select>
          </label>
          {planLoading && <p className="state">Считаем план…</p>}
          {!planLoading && !plan && sym && <p className="state err">Нет направленного плана.</p>}
          {plan && (
            <>
              <p className={`state ${setupCls(plan.direction)}`}>
                {setupText(plan.direction)} · уверенность {plan.confidence}% · {plan.summary.slice(0, 90)}
              </p>
              <div className="lvl"><span>Зона входа</span><b>{fmt(plan.entryLow, 4)}–{fmt(plan.entryHigh, 4)}</b></div>
              <div className="lvl"><span>Стоп</span><b>{fmt(plan.stop, 4)}</b></div>
              <div className="lvl"><span>TP1/TP2/TP3</span><b>{fmt(plan.tp1, 4)} / {fmt(plan.tp2, 4)} / {fmt(plan.tp3, 4)}</b></div>
              <div className="lvl"><span>Размер (риск {fmt(riskMoney)} $)</span><b>≈{fmt(previewQty, 4)} · маржа ≈{fmt(previewMargin, 1)} $</b></div>
              {ladder && ladderProblems.length === 0 && (
                <div className="lvl">
                  <span>Минимум для лесенки</span>
                  <b>{fmt(ladder.minNotional, 0)} $ · риск от {fmt(ladder.minRisk, 2)} $
                    {minDepositPct != null && minDepositPct > riskPct ? ` (${fmt(minDepositPct, 1)} % депозита)` : ''}</b>
                </div>
              )}
              {ladderProblems.length > 0 && (
                <p className="state err">
                  Биржа не примет такой размер: {ladderProblems.join(' ')} Нужна позиция от {fmt(ladder?.minNotional ?? 0, 0)} $
                  {' '}— риск не меньше {fmt(ladder?.minRisk ?? 0, 2)} $ (это {fmt(minDepositPct ?? 0, 1)} % депозита).
                  {' '}Уменьши риск % или возьми символ с мелким шагом количества.
                </p>
              )}
              {instQ.isError && <p className="state err">Не удалось получить ограничения биржи по символу: {String(instQ.error)}</p>}
              <div className="controls">
                <div className="seg" role="group" aria-label="Вид входа">
                  <button type="button" className={entryKind === 'limit' ? 'seg-active' : ''} onClick={() => setEntryKind('limit')}>Лимит</button>
                  <button type="button" className={entryKind === 'market' ? 'seg-active' : ''} onClick={() => setEntryKind('market')}>По рынку</button>
                </div>
                {(() => {
                  const why: string[] = [];
                  if (!confirmed && !testnet) why.push('отметь «Я понимаю: это реальные деньги»');
                  if (plan.direction !== 'long' && plan.direction !== 'short') why.push('сетап не направленный');
                  if (entryKind === 'limit' && ladderProblems.length > 0) why.push('риск ниже минимума лесенки');
                  if (why.length === 0) return null;
                  return <p className="state err">Вход недоступен: {why.join('; ')}.</p>;
                })()}
                <button
                  className={`btn ${testnet ? 'open-long' : 'btn-danger'}`}
                  onClick={doOpen}
                  disabled={busy || !canTrade || ladderProblems.length > 0 || (plan.direction !== 'long' && plan.direction !== 'short')}
                  title={entryKind === 'market'
                    ? 'Рыночный ордер исполняется сразу по текущей цене — проскальзывание входит в цену исполнения'
                    : 'Лимитный вход ждёт касания цены середины зоны'}
                >
                  {busy ? 'Открываем…' : entryKind === 'market' ? `Открыть по рынку (${testnet ? 'тестнет' : 'реально'})` : `Открыть лимитом (${testnet ? 'тестнет' : 'реально'})`}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3><Term t="position" label="Позиции (linear)" /></h3>
          {positionsQ.isError && <p className="state err">Не удалось загрузить позиции: {String(positionsQ.error)}</p>}
          {positions.length === 0 ? <p className="state">Нет открытых позиций.</p> : (
            <>
            {canTrade && (
              <div className="table-actions">
                <button className="btn btn-sm btn-close-all" disabled={busy} onClick={() => void doCloseAll()}>
                  {busy ? 'Закрываем…' : 'Закрыть все'}
                </button>
              </div>
            )}
            <div className="table-wrap">
              <table className="pin-right pin-right--narrow">
              <thead><tr><th>Символ</th><th>uP&L</th><th><Term t="margin" label="Маржа" /></th><th><Term t="risk" label="Риск" /></th><th className="act"></th></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const dir: 'long' | 'short' = p.side === 'Buy' ? 'long' : 'short';
                  const notional = p.size * p.avgPrice;
                  const margin = p.leverage > 0 ? notional / p.leverage : notional;
                  const riskUsd = p.stopLoss ? Math.abs(p.avgPrice - p.stopLoss) * p.size : null;
                  return (
                    <tr key={`${p.symbol}-${p.positionIdx}`}>
                      <td className="sym">
                        <PairLink symbol={p.symbol} category="linear" /><br />
                        <span className="muted">×{p.leverage} {p.side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'}</span>
                      </td>
                      <td className={p.unrealisedPnl >= 0 ? 'pos' : 'neg'}>{fmt(p.unrealisedPnl)} $<br /><span className="muted">вход {fmt(p.avgPrice, p.avgPrice < 1 ? 5 : 4)}</span></td>
                      <td className="muted">{fmt(margin)} $<br /><span className="muted">номинал {fmt(notional)} $</span></td>
                      <td className="muted">
                        {riskUsd == null ? '—' : `${fmt(riskUsd)} $`}
                        <br /><span className="muted">LIQ {p.liqPrice == null ? '—' : fmt(p.liqPrice, p.liqPrice < 1 ? 5 : 4)}</span>
                      </td>
                      <td className="act">
                        <div className="controls">
                          {p.symbol === sym && plan && plan.direction === dir && (
                            <button className="btn btn-sm" disabled={busy || !canTrade} onClick={() => void doPlaceLadder(p.symbol, dir, p.size)}>Выставить TP</button>
                          )}
                          <button className="btn btn-sm" disabled={busy || !canTrade} onClick={() => void doBreakeven(p.symbol, p.avgPrice)}>Стоп → Б/У</button>
                          <button className="btn btn-sm" disabled={busy || !canTrade} onClick={() => void doClose(p.symbol, dir)}>Закрыть</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            </>
          )}
        </div>
      </section>

      <section className="detail">
        <h3>Активные ордера ({orders.length})</h3>
        {ordersQ.isError && <p className="state err">Не удалось загрузить ордера: {String(ordersQ.error)}</p>}
        {orders.length === 0 ? <p className="state">Нет активных ордеров.</p> : (
          <div className="table-wrap">
            <table className="pin-right pin-right--narrow">
              <thead><tr><th>Символ</th><th>Сторона</th><th>Тип</th><th>Qty</th><th>Цена</th><th>Статус</th><th className="act"></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId}>
                    <td className="sym"><PairLink symbol={o.symbol} category="linear" /></td>
                    <td className={o.side === 'Buy' ? 'pos' : 'neg'}>{o.side === 'Buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</td>
                    <td>{o.orderType}{o.orderLinkId?.startsWith('tp') ? ' · TP' : ''}{o.orderLinkId?.startsWith('ent') ? ' · вход' : ''}</td>
                    <td>{fmt(o.qty, 4)}</td>
                    <td>{fmt(o.price, o.price < 1 ? 5 : 4)}</td>
                    <td>{o.orderStatus}</td>
                    <td className="act"><button className="btn btn-sm" onClick={() => void doCancelOrder(o.orderId, o.symbol)}>Отменить</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="detail">
        <h3>Свежие исполнения {api.ws === 'live' ? '' : '(пока поток не подключён — пусто)'}</h3>
        {account?.fills.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Время</th><th>Символ</th><th>Сторона</th><th>Цена</th><th>Qty</th><th>Комиссия</th><th>P&L</th></tr></thead>
              <tbody>
                {account.fills.map((f) => (
                  <tr key={f.execId}>
                    <td className="muted">{new Date(f.execTime).toLocaleTimeString('ru-RU')}</td>
                    <td className="sym"><PairLink symbol={f.symbol} category="linear" /></td>
                    <td className={f.side === 'Buy' ? 'pos' : 'neg'}>{f.side === 'Buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</td>
                    <td>{fmt(f.execPrice, f.execPrice < 1 ? 5 : 4)}</td>
                    <td>{fmt(f.execQty, 4)}</td>
                    <td className="muted">{fmt(f.execFee, 4)}</td>
                    <td className={f.execPnl > 0 ? 'pos' : f.execPnl < 0 ? 'neg' : 'muted'}>{fmt(f.execPnl, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="state">
            Исполнений ещё не было{api.ws === 'live' ? '.' : ': лента появится, как только приватный сокет подключится и биржа пришлёт первые сделки.'}
          </p>
        )}
      </section>

      <footer className="foot">
        Реальная торговля использует те же правила, что бумажная: рисковая дозировка, лимитный вход по середине
        зоны со стопом, лесенка 70/20/10 (reduce-only лимитки) и перенос стопа в безубыток после TP1.
        Движок работает, пока вкладка открыта.{' '}<WsBadge state={api.ws} testnet={testnet} />
      </footer>
    </div>
  );
}