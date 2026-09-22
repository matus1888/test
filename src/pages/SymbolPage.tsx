import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueries } from '@tanstack/react-query';
import {
  INTERVALS,
  INTERVAL_LABELS,
  bybitTradeUrl,
  fetchKlines,
  fetchTickers,
  isCategory,
  isInterval,
  type Category,
  type Interval,
} from '../api/bybit';
import { computeMetrics } from '../lib/metrics';
import { fmt, fmtCompact, fmtPct } from '../lib/format';
import { setupCls, setupText } from '../lib/ui';
import { buildTradePlan } from '../lib/tradePlan';
import StrategyChart from '../components/StrategyChart';
import Term from '../components/Term';
import TermList from '../components/TermList';
import QuickTrade from '../components/QuickTrade';
import { ExternalIcon } from '../components/icons';
import { useSessionState } from '../hooks/useSessionState';
import { usePaperPositions } from '../hooks/usePaper';
import { uid } from '../lib/paper';

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;

export default function SymbolPage() {
  const { category: catParam, symbol: symParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [deposit, setDeposit] = useSessionState<number>('symbol:deposit', 1000, isPositiveNumber);
  const [riskPct, setRiskPct] = useSessionState<number>('symbol:riskPct', 1, isPositiveNumber);
  const [copied, setCopied] = useState(false);
  const [storedInterval, setStoredInterval] = useSessionState<Interval>('symbol:interval', '5', isInterval);
  const [stake, setStake] = useSessionState<number>('paper:stake', 100, isPositiveNumber);
  const [lev, setLev] = useSessionState<number>('paper:leverage', 3, isPositiveNumber);
  const navigate = useNavigate();
  const { add } = usePaperPositions();

  const category: Category = isCategory(catParam) ? catParam : 'linear';
  const symbol = symParam ? decodeURIComponent(symParam) : '';
  const urlInterval = searchParams.get('interval');
  // Приоритет: ?interval= в адресе, иначе сохранённый выбор
  const interval: Interval = urlInterval && isInterval(urlInterval) ? urlInterval : storedInterval;

  const setInterval = (v: Interval) => {
    setStoredInterval(v);
    setSearchParams({ interval: v }, { replace: true });
  };

  const tickers = useQuery({
    queryKey: ['tickers', category],
    queryFn: () => fetchTickers(category),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const klines = useQuery({
    queryKey: ['kline', category, symbol, interval, 200],
    queryFn: () => fetchKlines(category, symbol, interval, 200),
    enabled: symbol.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const ticker = (tickers.data ?? []).find((t) => t.symbol === symbol);
  const metrics = useMemo(
    () => (klines.data && klines.data.length >= 55 ? computeMetrics(klines.data) : null),
    [klines.data],
  );
  const plan = useMemo(
    () => (klines.data && metrics ? buildTradePlan(klines.data, metrics, category, ticker?.fundingRate ?? null, interval) : null),
    [klines.data, metrics, category, ticker, interval],
  );

  // Свечи сразу по всем таймфреймам для таблицы раскладов
  const tfKlines = useQueries({
    queries: INTERVALS.map((iv) => ({
      queryKey: ['kline', category, symbol, iv, 200],
      queryFn: () => fetchKlines(category, symbol, iv, 200),
      enabled: symbol.length > 0,
      staleTime: 60_000,
      retry: 1,
    })),
  });
  const tfPlans = useMemo(
    () =>
      INTERVALS.map((iv, idx) => {
        const data = tfKlines[idx]?.data;
        const m = data && data.length >= 55 ? computeMetrics(data) : null;
        const p = data && m ? buildTradePlan(data, m, category, ticker?.fundingRate ?? null, iv) : null;
        return { interval: iv, plan: p };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tfKlines, category, ticker],
  );
  const tfPending = tfKlines.filter((q) => q.isPending).length;

  const priceDecimals = (plan?.price ?? ticker?.lastPrice ?? 0) < 1 ? 5 : 2;
  const tradeUrl = bybitTradeUrl(category, symbol);
  const pctFrom = (level: number) => {
    const p = plan?.price ?? 0;
    if (!p) return '—';
    return fmtPct(((level / p) - 1) * 100);
  };

  // Калькулятор позиции
  const riskMoney = deposit * (riskPct / 100);
  const qty = plan && plan.riskDist > 0 ? riskMoney / plan.riskDist : 0;
  const notional = qty * (plan?.entryMid ?? 0);

  // Бумажный вход: ставка + плечо, цена — текущая по рынку
  const entryPrice = ticker?.lastPrice ?? plan?.price ?? 0;
  const paperQty = entryPrice > 0 ? (stake * lev) / entryPrice : 0;
  const openPaper = () => {
    if (!plan || plan.direction === 'wait' || entryPrice <= 0 || stake <= 0 || lev <= 0) return;
    const id = uid();
    add({
      id,
      symbol,
      category,
      interval,
      direction: plan.direction,
      entryPrice,
      stake,
      leverage: lev,
      qty: paperQty,
      stop: plan.stop,
      tp1: plan.tp1,
      tp2: plan.tp2,
      tp3: plan.tp3,
      entryLow: plan.entryLow,
      entryHigh: plan.entryHigh,
      confidence: plan.confidence,
      openedAt: Date.now(),
      status: 'open',
    });
    navigate(`/paper/${id}`);
  };

  const copyPlan = async () => {
    if (!plan) return;
    const text = [
      `${symbol} ${category} ${INTERVAL_LABELS[interval]} — ${plan.direction.toUpperCase()} (уверенность ${plan.confidence}%)`,
      plan.summary,
      `Вход зоной: ${fmt(plan.entryLow, priceDecimals)} – ${fmt(plan.entryHigh, priceDecimals)} (середина ${fmt(plan.entryMid, priceDecimals)})`,
      `Стоп: ${fmt(plan.stop, priceDecimals)}`,
      `TP1 ${fmt(plan.tp1, priceDecimals)} (1R) / TP2 ${fmt(plan.tp2, priceDecimals)} (2R) / TP3 ${fmt(plan.tp3, priceDecimals)} (3R)`,
      `Риски: ${plan.risks.join(' | ')}`,
      'Не финансовая рекомендация.',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard недоступен */ }
  };

  if (!symbol) return <div className="page"><p className="state err">Нет символа в адресе.</p><Link to="/">← Назад</Link></div>;

  return (
    <div className="page">
      <Link to="/" className="back">← Назад к скринеру</Link>

      <header className="top">
        <div>
          <h1>{symbol} <span className="muted">· {category} · {INTERVAL_LABELS[interval]}</span></h1>
          <p className="sub">
            {ticker ? (
              <>
                <Term t="price" label="Цена" /> {fmt(ticker.lastPrice, priceDecimals)} ·{' '}
                <Term t="turnover" label="Оборот 24ч" /> {fmtCompact(ticker.turnover24h)} ·{' '}
                <Term t="funding" label="Фандинг" /> {ticker.fundingRate === null ? '—' : `${fmt(ticker.fundingRate * 100, 4)}%`}
              </>
            ) : 'Загрузка тикера…'}
            {plan ? <> · {plan.horizon}</> : null}
          </p>
        </div>
        <label><Term t="timeframe" label="Таймфрейм" />
          <select name="interval" value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
            {INTERVALS.map((i) => <option key={i} value={i}>{INTERVAL_LABELS[i]}</option>)}
          </select>
        </label>
      </header>

      {klines.isPending && <p className="state">Загрузка свечей {symbol}…</p>}
      {klines.isError && <p className="state err">Ошибка свечей: {String(klines.error instanceof Error ? klines.error.message : klines.error)}</p>}

      {metrics && plan && (
        <>
          <section className={`signal dir-${plan.direction}`}>
            <div className="signal-main">
              <span className="dir">
                <Term t="direction" label={plan.direction === 'wait' ? 'ВНЕ РЫНКА' : plan.direction === 'long' ? 'ЛОНГ' : 'ШОРТ'} />
              </span>
              <span className="conf"><Term t="confidence" label={`Уверенность ${plan.confidence}%`} /></span>
              {tradeUrl && (
                <a className="ext" href={tradeUrl} target="_blank" rel="noreferrer" aria-label={`Открыть ${symbol} на бирже Bybit`}>
                  <ExternalIcon /><span>На биржу</span>
                </a>
              )}
            </div>
            <p className="signal-summary">{plan.summary}</p>
            <p className="state">
              <Term t="regime" label={plan.regime} /> · <Term t="ema" label="EMA20" /> {fmt(plan.ema20, priceDecimals)} ·{' '}
              <Term t="ema" label="EMA50" /> {fmt(plan.ema50, priceDecimals)} ·{' '}
              <Term t="atr" label="ATR" /> {fmt(plan.atr, priceDecimals)}
            </p>
            <p className="state"><Term t="setup" label="Сетап" />: {plan.setup}</p>
          </section>

          {plan.direction === 'wait' ? (
            <p className="state">Нет направленного сетапа — вход недоступен.</p>
          ) : (
            <QuickTrade
              direction={plan.direction}
              entryPrice={entryPrice}
              decimals={priceDecimals}
              stake={stake}
              setStake={setStake}
              lev={lev}
              setLev={setLev}
              qty={paperQty}
              onOpen={openPaper}
            />
          )}

          {klines.data && <StrategyChart candles={klines.data} plan={plan} />}

          <section className="detail">
            <h3><Term t="timeframe" label="Расклады по таймфреймам" /></h3>
            {tfPending > 0 && <p className="state">Загрузка раскладов… ({tfPlans.length - tfPending}/{tfPlans.length})</p>}
            <div className="table-wrap">
              <table className="tf-table">
                <thead>
                  <tr>
                    <th>Таймфрейм</th>
                    <th><Term t="direction" label="Сетап" /></th>
                    <th><Term t="confidence" label="Увер. %" /></th>
                    <th><Term t="entryZone" label="Вход" /></th>
                    <th><Term t="stop" label="Стоп" /></th>
                    <th><Term t="tp" label="TP2" /></th>
                  </tr>
                </thead>
                <tbody>
                  {tfPlans.map(({ interval: iv, plan: p }) => (
                    <tr key={iv} onClick={() => setInterval(iv)} className={iv === interval ? 'sel' : ''}>
                      <td className="sym">{INTERVAL_LABELS[iv]}</td>
                      <td className={setupCls(p?.direction ?? null)}>{p ? setupText(p.direction) : '…'}</td>
                      <td>{p ? `${p.confidence}%` : '…'}</td>
                      <td>{p ? `${fmt(p.entryLow, priceDecimals)}–${fmt(p.entryHigh, priceDecimals)}` : '…'}</td>
                      <td>{p ? (p.direction === 'wait' ? '—' : fmt(p.stop, priceDecimals)) : '…'}</td>
                      <td>{p ? (p.direction === 'wait' ? '—' : fmt(p.tp2, priceDecimals)) : '…'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="state">Клик по строке переключает таймфрейм страницы.</p>
          </section>

          <section className="cards">
            <div className="card">
              <h3><Term t="entry" label="Вход" /></h3>
              {plan.direction === 'wait'
                ? <p className="state">Жди границы: <Term t="support" label="поддержка" /> {fmt(plan.recentLow, priceDecimals)}, <Term t="resistance" label="сопротивление" /> {fmt(plan.recentHigh, priceDecimals)}.</p>
                : <>
                    <div className="lvl"><span><Term t="entryZone" label="Зона" /></span><b>{fmt(plan.entryLow, priceDecimals)} – {fmt(plan.entryHigh, priceDecimals)}</b></div>
                    <div className="lvl"><span><Term t="entryMid" label="Середина" /></span><b>{fmt(plan.entryMid, priceDecimals)}</b></div>
                    <p className="state"><Term t="limit" label="Лимитной заявкой" /> в зоне, не по рынку.</p>
                  </>}
            </div>
            <div className="card">
              <h3><Term t="stop" label="Выход · стоп" /></h3>
              {plan.direction === 'wait'
                ? <p className="state">Стопов нет — нет позиции.</p>
                : <>
                    <div className="lvl"><span><Term t="stop" label="Стоп" /></span><b className="neg">{fmt(plan.stop, priceDecimals)} ({pctFrom(plan.stop)})</b></div>
                    <p className="state">Риск от середины входа: {fmt(plan.riskDist, priceDecimals)} · ~{(plan.riskDist / plan.price * 100).toFixed(2)}%.</p>
                  </>}
            </div>
            <div className="card">
              <h3>{plan.direction === 'wait' ? 'Сценарии пробоя' : <Term t="tp" label="Выход · тейки" />}</h3>
              {plan.direction === 'wait' ? (
                <>
                  <div className="lvl"><span><Term t="breakout" label="Лонг при закрепе выше" /></span><b className="pos">{fmt(plan.recentHigh, priceDecimals)} ({pctFrom(plan.recentHigh)})</b></div>
                  {category === 'spot'
                    ? <p className="state">Спот: только лонг-сценарий, шорт недоступен.</p>
                    : <div className="lvl"><span><Term t="breakout" label="Шорт при закрепе ниже" /></span><b className="neg">{fmt(plan.recentLow, priceDecimals)} ({pctFrom(plan.recentLow)})</b></div>}
                </>
              ) : (
                <>
                  <div className="lvl"><span><Term t="tp" label="TP1 · 1R" /></span><b className="pos">{fmt(plan.tp1, priceDecimals)} ({pctFrom(plan.tp1)})</b></div>
                  <div className="lvl"><span><Term t="tp" label="TP2 · 2R" /></span><b className="pos">{fmt(plan.tp2, priceDecimals)} ({pctFrom(plan.tp2)})</b></div>
                  <div className="lvl"><span><Term t="tp" label="TP3 · 3R" /></span><b className="pos">{fmt(plan.tp3, priceDecimals)} ({pctFrom(plan.tp3)})</b></div>
                  <p className="state">TP1 — снять часть и <Term t="breakeven" label="стоп в безубыток" />.</p>
                </>
              )}
            </div>
            <div className="card">
              <h3><Term t="qty" label="Размер позиции" /></h3>
              <label>Депозит, $
                <input name="deposit" type="number" min={0} value={deposit} onChange={(e) => setDeposit(Number(e.target.value))} />
              </label>
              <label><Term t="risk" label="Риск, %" />
                <input name="riskPct" type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} />
              </label>
              <div className="lvl"><span><Term t="risk" label="Риск, $" /></span><b>{fmt(riskMoney)}</b></div>
              {plan.direction === 'wait'
                ? <p className="state">Позиции нет — количество рассчитается при направленном сетапе.</p>
                : <>
                    <div className="lvl"><span><Term t="qty" label="Количество" /></span><b>{fmt(qty, 4)}</b></div>
                    <div className="lvl"><span><Term t="notional" label="Сумма позиции, $" /></span><b>{fmtCompact(notional)}</b></div>
                  </>}
            </div>
          </section>

          <section className="detail">
            <h3>Метрики ({INTERVAL_LABELS[interval]} ×{klines.data?.length ?? 0})</h3>
            <div className="mgrid">
              <Metric gloss="change" label="Изменение за окно" value={fmtPct(metrics.changePct)} />
              <Metric gloss="momentum" label="Импульс · 10 свечей" value={fmtPct(metrics.momentumPct)} />
              <Metric gloss="trend" label="Наклон тренда" value={fmtPct(metrics.trendSlopePct)} />
              <Metric gloss="r2" label="R²" value={fmt(metrics.trendR2, 3)} />
              <Metric gloss="streak" label="Серия" value={String(metrics.streak)} />
              <Metric gloss="rsi" label="RSI · 14" value={fmt(metrics.rsi, 1)} />
              <Metric gloss="volatilityRange" label="Волат. диапазон" value={fmt(metrics.volatilityRange)} />
              <Metric gloss="volatilityStd" label="Волат. σ" value={fmt(metrics.volatilityStd)} />
              <Metric gloss="atr" label="ATR %" value={fmt(metrics.atrPct)} />
              <Metric gloss="volumeRatio" label="Объём ×" value={fmt(metrics.volumeRatio)} />
              <Metric gloss="score" label="Скор" value={fmt(metrics.score)} />
              <Metric gloss="range20" label="Диапазон · 20" value={`${fmt(plan.recentLow, priceDecimals)}–${fmt(plan.recentHigh, priceDecimals)}`} />
            </div>
          </section>

          <section className="cols">
            <div className="detail">
              <h3><Term t="risks" label="Риски" /></h3>
              <TermList items={plan.risks} />
            </div>
            <div className="detail">
              <h3><Term t="invalidation" label="Инвалидация" /></h3>
              <TermList items={plan.invalidation} />
            </div>
            <div className="detail">
              <h3><Term t="checklist" label="Чеклист" /></h3>
              <TermList items={plan.checklist} />
            </div>
          </section>

          <div className="controls">
            <button className="btn" onClick={copyPlan}>{copied ? 'Скопировано ✓' : 'Копировать план'}</button>
            <button className="btn" onClick={() => klines.refetch()} disabled={klines.isFetching}>
              {klines.isFetching ? 'Обновление…' : 'Обновить свечи'}
            </button>
          </div>
        </>
      )}

      {klines.data && (!metrics || !plan) && !klines.isPending && (
        <p className="state err">Мало свечей для плана (нужно от 55, пришло {klines.data.length}).</p>
      )}

      <footer className="foot">
        План строится локально по 200 свечам: EMA20/50, ATR(14), диапазон 20 свечей, RSI, наклон/R².
        График: последние 120 свечей, зона входа, стоп и тейки. Уровни: стоп 1,8×ATR, цели 1R/2R/3R. Это не финансовая рекомендация.
      </footer>
    </div>
  );
}

function Metric({ gloss, label, value }: { gloss: string; label: string; value: string }) {
  return <div className="metric"><span><Term t={gloss} label={label} /></span><b>{value}</b></div>;
}
