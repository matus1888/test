import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  INTERVALS,
  INTERVAL_LABELS,
  fetchKlines,
  fetchTickers,
  type Interval,
} from '../api/bybit';
import {
  cancelOrder,
  clearCredentials,
  fetchActiveOrders,
  fetchWalletBalance,
  loadCredentials,
  type ApiCredentials,
} from '../api/privateApi';
import { closeReal, fetchLivePositions, getInstrument, moveStopToBreakeven, openReal, planLadder } from '../api/live';
import { computeMetrics } from '../lib/metrics';
import { buildTradePlan, type TradePlan } from '../lib/tradePlan';
import { useSessionState } from '../hooks/useSessionState';
import { parseLiveLink } from '../lib/tradeMode';
import { fmt, fmtCompact } from '../lib/format';
import { setupCls, setupText } from '../lib/ui';
import Term from '../components/Term';
import EnvBadge from '../components/EnvBadge';

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;

/** Реальная торговля через API Bybit (сеть — та, что в сохранённых ключах). */
export default function LivePage() {
  const [cred] = useState<ApiCredentials | null>(() => loadCredentials());
  // Предзаполнение из ссылки «Реальный вход →» в скринере/плане: /live?symbol=…&interval=…
  const [link] = useSearchParams();
  const fromLink = useMemo(() => parseLiveLink(`?${link.toString()}`), [link]);
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const testnet = !!cred?.testnet;
  const sym = symbol.trim().toUpperCase();

  const balanceQ = useQuery({
    queryKey: ['live', 'wallet', testnet],
    queryFn: () => fetchWalletBalance(cred!),
    enabled: !!cred,
    refetchInterval: 12_000,
  });
  const positionsQ = useQuery({
    queryKey: ['live', 'positions', testnet],
    queryFn: () => fetchLivePositions(cred!),
    enabled: !!cred,
    refetchInterval: 12_000,
  });
  const ordersQ = useQuery({
    queryKey: ['live', 'orders', testnet],
    queryFn: () => fetchActiveOrders(cred!),
    enabled: !!cred,
    refetchInterval: 12_000,
  });
  const planQ = useQuery({
    queryKey: ['live', 'plan', sym, interval],
    queryFn: async () => {
      const [kl, tk] = await Promise.all([fetchKlines('linear', sym, interval, 200), fetchTickers('linear')]);
      const ticker = tk.find((t) => t.symbol === sym) ?? null;
      const m = computeMetrics(kl);
      return m && kl.length >= 55 ? buildTradePlan(kl, m, 'linear', ticker?.fundingRate ?? null, interval) : null;
    },
    enabled: sym.length > 0,
  });

  const plan: TradePlan | null = planQ.data ?? null;
  const planLoading = planQ.isFetching;
  const canTrade = testnet || confirmed;

  // Ограничения биржи по символу (шаг количества, минимальный номинал) — один раз на символ.
  const instQ = useQuery({
    queryKey: ['live', 'inst', sym, cred?.testnet ?? false],
    queryFn: () => getInstrument(cred as ApiCredentials, 'linear', sym),
    enabled: !!cred && sym.length > 0,
    staleTime: 900_000,
    retry: false,
  });

  const reload = () => {
    void balanceQ.refetch();
    void positionsQ.refetch();
    void ordersQ.refetch();
  };

  const doOpen = async () => {
    if (!cred || !plan || !canTrade) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      const riskMoney = deposit * (riskPct / 100);
      const res = await openReal(cred, { category: 'linear', symbol: sym, plan, riskMoney, leverage: lev });
      setNotice(`${sym} ${plan.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'}: вход ${res.entryOrder.orderId}, TP-лимиток ${res.tpOrders.length}, qty ${res.qty}, маржа ~${fmt(res.margin, 0)} $`);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doClose = async (s: string, direction: 'long' | 'short') => {
    if (!cred || !canTrade) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      await closeReal(cred, { category: 'linear', symbol: s, direction });
      setNotice(`${s}: закрыт по рынку`);
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
      setNotice(`${s}: стоп перенесён в безубыток`);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doCancelOrder = async (orderId: string) => {
    if (!cred) return;
    setActionError(null);
    try {
      await cancelOrder(cred, 'linear', orderId);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!cred) {
    return (
      <div className="page">
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
  const positions = positionsQ.data ?? [];
  const orders = ordersQ.data ?? [];
  const unreal = positions.reduce((a, p) => a + p.unrealisedPnl, 0);

  return (
    <div className="page">
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

      {(actionError || planQ.isError) && <p className="state err">{actionError ?? String(planQ.error ?? '')}</p>}
      {notice && <p className="state pos">{notice}</p>}

      <section className="cards">
        <div className="card">
          <h3>Открыть реальный ордер из плана</h3>
          <label>Символ
            <input name="liveSymbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="BTCUSDT" />
          </label>
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
                <button className={`btn ${testnet ? 'open-long' : 'btn-danger'}`} onClick={doOpen} disabled={busy || !canTrade || ladderProblems.length > 0}>
                  {busy ? 'Открываем…' : `Открыть ордер (${testnet ? 'тестнет' : 'реально'})`}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3><Term t="position" label="Позиции (linear)" /></h3>
          {positionsQ.isError && <p className="state err">Не удалось загрузить позиции: {String(positionsQ.error)}</p>}
          {positions.length === 0 ? <p className="state">Нет открытых позиций.</p> : (
            <table>
              <tbody>
                {positions.map((p) => {
                  const dir: 'long' | 'short' = p.side === 'Buy' ? 'long' : 'short';
                  return (
                    <tr key={`${p.symbol}-${p.positionIdx}`}>
                      <td className="sym">{p.symbol}<br /><span className="muted">×{p.leverage} {p.side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'}</span></td>
                      <td className={p.unrealisedPnl >= 0 ? 'pos' : 'neg'}>{fmt(p.unrealisedPnl)} $<br /><span className="muted">вход {fmt(p.avgPrice, p.avgPrice < 1 ? 5 : 4)}</span></td>
                      <td className="muted">LIQ {p.liqPrice == null ? '—' : fmt(p.liqPrice, p.liqPrice < 1 ? 5 : 4)}</td>
                      <td>
                        <div className="controls">
                          <button className="btn btn-sm" disabled={busy || !canTrade} onClick={() => void doBreakeven(p.symbol, p.avgPrice)}>Стоп → Б/У</button>
                          <button className="btn btn-sm" disabled={busy || !canTrade} onClick={() => void doClose(p.symbol, dir)}>Закрыть</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="detail">
        <h3>Активные ордера ({orders.length})</h3>
        {ordersQ.isError && <p className="state err">Не удалось загрузить ордера: {String(ordersQ.error)}</p>}
        {orders.length === 0 ? <p className="state">Нет активных ордеров.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Символ</th><th>Сторона</th><th>Тип</th><th>Qty</th><th>Цена</th><th>Статус</th><th></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId}>
                    <td className="sym">{o.symbol}</td>
                    <td className={o.side === 'Buy' ? 'pos' : 'neg'}>{o.side === 'Buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</td>
                    <td>{o.orderType}{o.orderLinkId?.startsWith('tp') ? ' · TP' : ''}{o.orderLinkId?.startsWith('ent') ? ' · вход' : ''}</td>
                    <td>{fmt(o.qty, 4)}</td>
                    <td>{fmt(o.price, o.price < 1 ? 5 : 4)}</td>
                    <td>{o.orderStatus}</td>
                    <td><button className="btn btn-sm" onClick={() => void doCancelOrder(o.orderId)}>Отменить</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="foot">
        Реальная торговля использует те же правила, что бумажная: рисковая дозировка, лимитный вход по середине
        зоны со стопом, лесенка 70/20/10 (reduce-only лимитки) и перенос стопа в безубыток после TP1.
        Движок работает, пока вкладка открыта.
      </footer>
    </div>
  );
}