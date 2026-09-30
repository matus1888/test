import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { recordSignalSnapshot } from '../lib/signalLog';
import MarketOverview from '../components/MarketOverview';
import {
  CATEGORIES,
  INTERVALS,
  INTERVAL_LABELS,
  isCategory,
  isInterval,
  type Category,
  type Interval,
} from '../api/bybit';
import { useKlines, useTickers } from '../hooks/useMarket';
import { usePaperPositions } from '../hooks/usePaper';
import { useSessionState } from '../hooks/useSessionState';
import { useTradingMode } from '../hooks/useTradingMode';
import { fmt, fmtCompact, fmtPct, fmtPctAbs } from '../lib/format';
import { entryBlockReason, makePaperPosition, type EntryKind } from '../lib/paper';
import { describeRefresh, effectiveCycleMs, perCycleFor } from '../lib/klinePlan';
import { hiddenReasonsCount, splitSuspicious, SUSPICIOUS } from '../lib/pairFilter';
import { liveHref } from '../lib/tradeMode';
import { numCls, rowKeyProps, setupCls, setupText } from '../lib/ui';
import { CAT_GLOSS, CONF_OPTIONS, REFRESH_OPTIONS } from '../lib/options';
import {
  COLUMNS,
  buildRows,
  filterByConfidence,
  priorityOf,
  sortRows,
  type Row,
  type SortKey,
} from '../lib/screener';
import Term from '../components/Term';
import PairLink from '../components/PairLink';

const isLimit = (v: unknown): v is number =>
  typeof v === 'number' && [25, 50, 100, 200].includes(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isSortKey = (v: unknown): v is SortKey =>
  typeof v === 'string' && COLUMNS.some((c) => c.key === v);
const isSortDir = (v: unknown): v is 1 | -1 => v === 1 || v === -1;
const isRefresh = (v: unknown): v is number =>
  typeof v === 'number' && [0, 15, 30, 60, 120, 300, 50, 70, 80, 90].includes(v);
const isConf = (v: unknown): v is number =>
  typeof v === 'number' && [0, 50, 60, 70, 80, 90].includes(v);
const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export default function ScreenerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { positions, add } = usePaperPositions();
  const [mode] = useTradingMode();
  const real = mode === 'real';
  // Символ храним отдельно от текста, чтобы в уведомлении он был ссылкой на биржу,
  // а не простой строкой (см. PairLink).
  const [entryMsg, setEntryMsg] = useState<{ symbol: string; text: string; ok: boolean } | null>(null);
  const [category, setCategory] = useSessionState<Category>('screener:category', 'linear', isCategory);
  const [interval, setInterval] = useSessionState<Interval>('screener:interval', '5', isInterval);
  const [maxSymbols, setMaxSymbols] = useSessionState<number>('screener:limit', 50, isLimit);
  const [search, setSearch] = useSessionState<string>('screener:search', '', isString);
  const [sortKey, setSortKey] = useSessionState<SortKey>('screener:sortKey', 'priority', isSortKey);
  const [sortDir, setSortDir] = useSessionState<1 | -1>('screener:sortDir', -1, isSortDir);
  const [refreshSec, setRefreshSec] = useSessionState<number>('screener:refresh', 60, isRefresh);
  const [minConf, setMinConf] = useSessionState<number>('screener:minConf', 80, isConf);
  // Параметры быстрого входа — те же ключи, что на странице символа (общая сессия).
  const [deposit] = useSessionState<number>('symbol:deposit', 1000, isPositiveNumber);
  const [riskPct] = useSessionState<number>('symbol:riskPct', 1, isPositiveNumber);
  const [stake] = useSessionState<number>('paper:stake', 100, isPositiveNumber);
  const [lev] = useSessionState<number>('paper:leverage', 3, isPositiveNumber);
  // Отсев сомнительных пар (мало ликвидности / вялый ход / не влезает по марже). По умолчанию включён.
  const [safePairs, setSafePairs] = useSessionState<boolean>('screener:safePairs', true, isBool);

  const riskMoney = deposit * (riskPct / 100);
  const suspicionOpts = useMemo(
    () => ({ riskMoney, leverage: lev, stake }),
    [riskMoney, lev, stake],
  );

  const refreshMs = refreshSec === 0 ? false : refreshSec * 1000;
  const tickers = useTickers(category, refreshMs);

  const tmap = useMemo(
    () => new Map((tickers.data ?? []).map((t) => [t.symbol, t])),
    [tickers.data],
  );
  const scanned = useMemo(() => {
    const list = tickers.data ?? [];
    const q = search.trim().toUpperCase();
    const filtered = q ? list.filter((t) => t.symbol.includes(q)) : list;
    return [...filtered]
      .sort((a, b) => b.turnover24h - a.turnover24h)
      .slice(0, maxSymbols)
      .map((t) => t.symbol);
  }, [tickers.data, search, maxSymbols]);

  // Пред-фильтр по обороту: тонкие пары отсекаем ДО загрузки свечей.
  // Это экономит запросы — при 200 монетах минус половина выборки ещё до kline.
  const tradable = useMemo(
    () => (safePairs ? scanned.filter((s) => (tmap.get(s)?.turnover24h ?? 0) >= SUSPICIOUS.minTurnover) : scanned),
    [scanned, tmap, safePairs],
  );

  // Свечи: цикл привязан к таймфрейму, за цикл обновляется часть выборки.
  const cycleMs = effectiveCycleMs(interval, refreshMs) || 75_000;
  const klineBudget = perCycleFor(tradable.length, cycleMs);
  const klines = useKlines(category, tradable, interval, 200, {
    enabled: (tickers.data?.length ?? 0) > 0,
    refreshMs,
    perCycle: klineBudget,
  });

  const allRows = useMemo(
    () => buildRows(tradable, tickers.data ?? [], klines, category, interval),
    [tradable, tickers.data, klines, category, interval],
  );
  // Отсев сомнительных пар: смотрим на всю просканированную выборку, а не на отфильтрованную таблицу.
  const { kept, hidden } = useMemo(
    () => (safePairs ? splitSuspicious(allRows, suspicionOpts) : { kept: allRows, hidden: [] }),
    [allRows, safePairs, suspicionOpts],
  );
  const hiddenCounts = useMemo(() => hiddenReasonsCount(hidden), [hidden]);
  const sorted = useMemo(() => sortRows(kept, sortKey, sortDir), [kept, sortKey, sortDir]);
  // Фильтр по уверенности: только направленные сетапы с уверенностью не ниже порога
  const visible = useMemo(() => filterByConfidence(sorted, minConf), [sorted, minConf]);
  const setupCount = kept.filter((r) => r.direction === 'long' || r.direction === 'short').length;
  const openByDirection = useMemo(
    () => ({
      long: positions.filter((p) => (p.status === 'open' || p.status === 'pending') && p.direction === 'long').length,
      short: positions.filter((p) => (p.status === 'open' || p.status === 'pending') && p.direction === 'short').length,
    }),
    [positions],
  );

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === 'symbol' ? 1 : -1); }
  };

  const openSymbol = (s: string) => {
    navigate(`/s/${category}/${encodeURIComponent(s)}?interval=${interval}`);
  };

  /** Быстрый вход из таблицы: берёт план строки и текущие параметры риска/плеча. */
  const quickEntry = (r: Row, kind: EntryKind = 'limit') => {
    if (!r.plan) return;
    const direction: 'long' | 'short' = r.plan.direction === 'short' ? 'short' : 'long';
    const draft = { symbol: r.symbol, category, interval, direction };
    const entry = { kind, price: r.plan.price } as const;
    const reason = entryBlockReason(positions, draft, r.plan, { deposit, riskPct, stake, leverage: lev }, entry);
    if (reason) {
      setEntryMsg({ symbol: r.symbol, text: reason, ok: false });
      return;
    }
    const pos = makePaperPosition(r.symbol, category, interval, r.plan, { deposit, riskPct, stake, leverage: lev }, entry);
    if (!add(pos)) {
      setEntryMsg({ symbol: r.symbol, text: 'вход заблокирован — дубль или лимит', ok: false });
      return;
    }
    const riskNow = `${fmt(riskMoney)} $`;
    if (kind === 'market') {
      const dist = Math.abs(pos.entryPrice - pos.stop);
      const planDist = r.plan.riskDist;
      setEntryMsg({
        symbol: r.symbol,
        text: `вход по рынку ${fmt(pos.entryPrice)} · риск ${riskNow} ×${pos.leverage} · `
          + `до стопа ${fmtPctAbs((dist / pos.entryPrice) * 100, 2)} вместо ${fmtPctAbs((planDist / pos.entryPrice) * 100, 2)} по плану`
          + ` · проскальзывание в бумаге не учитывается`,
        ok: true,
      });
      return;
    }
    const toLimit = ((r.plan.price - pos.entryPrice) * (pos.direction === 'long' ? 1 : -1)) / pos.entryPrice;
    const wait = toLimit > 0
      ? `цена сейчас ${pos.direction === 'long' ? 'выше' : 'ниже'} лимита ${fmt(pos.entryPrice)}`
        + ` на ${fmtPctAbs(toLimit * 100, 2)} — ждём ${pos.direction === 'long' ? 'отката' : 'роста'}`
      : `лимит ${fmt(pos.entryPrice)} уже в рынке — заявка исполнится сразу`;
    setEntryMsg({
      symbol: r.symbol,
      text: `заявка выставлена · лимит ${fmt(pos.entryPrice)} · риск ${riskNow} ×${pos.leverage} · ${wait}`,
      ok: true,
    });
  };

  /**
   * Кнопка входа в строке. В бумажном режиме выставляет виртуальную лимитную
   * заявку (позиция появится после касания лимита), в реальном — ведёт на форму
   * реального ордера (/live), где нужен явный подтверждающий клик: из таблицы
   * деньги не тратятся.
   */
  const entryAction = (r: Row) => {
    if (!r.plan) return;
    if (real) {
      navigate(liveHref(r.symbol, interval));
      return;
    }
    quickEntry(r);
  };

  /** Вход по рынку из строки. В реальном режиме ведём на /live в режиме «по рынку»
   *  (`&kind=market`) — сам рыночный ордер отправляется только с /live после подтверждения. */
  const marketEntryAction = (r: Row) => {
    if (!r.plan) return;
    if (real) {
      navigate(liveHref(r.symbol, interval, 'market'));
      return;
    }
    quickEntry(r, 'market');
  };

  const klineLoading = klines.some((k) => k.loading);
  const klineRefreshing = klines.some((k) => k.fetching);
  const klineErrors = klines.filter((k) => k.error).length;
  const refreshLabel = REFRESH_OPTIONS.find((o) => o.value === refreshSec)?.label ?? '';

  // Журнал сигналов: снимок сетапов при каждом завершённом прогоне (тикеры
  // обновились, свечи не грузятся). Запись идемпотентна — дубли кадра гасит
  // сам recordSignalSnapshot. Deopt: только при реальном обновлении данных.
  useEffect(() => {
    if (tickers.dataUpdatedAt === 0 || klineLoading) return;
    recordSignalSnapshot(kept, category, interval, tickers.dataUpdatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.dataUpdatedAt, category, interval, klineLoading, kept]);

  /**
   * Ручное «Обновить»: тикеры сразу + свечи всей текущей выборки (через FIFO-очередь),
   * без ожидания циклического бюджета. Иначе в таблице остаются сетапы, посчитанные
   * по старым свечам, — «протухшие». Свечи без данных на этот прогон не заказываем:
   * рефетчим только то, что уже есть в кэше запросов.
   */
  const refreshAll = () => {
    void tickers.refetch();
    if (tradable.length === 0) return;
    void qc.refetchQueries({
      predicate: (q) =>
        q.queryKey[0] === 'kline'
        && q.queryKey[1] === category
        && q.queryKey[3] === interval
        && q.queryKey[4] === 200
        && typeof q.queryKey[2] === 'string'
        && tradable.includes(q.queryKey[2]),
    });
  };

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Скринер Bybit</h1>
          <p className="sub">Публичные данные Bybit V5 · ранжирование монет по волатильности и тренду</p>
        </div>
        <div className="top-actions">
          <MarketOverview
            rows={kept}
            category={category}
            interval={interval}
            openByDirection={openByDirection}
            hidden={hidden}
            loading={klineLoading}
          />
          <button className="btn" onClick={refreshAll} disabled={tickers.isFetching || klineRefreshing}>
            {tickers.isFetching || klineRefreshing ? 'Обновление…' : 'Обновить'}
          </button>
        </div>
      </header>

      <div className="controls">
        <div className="seg">
          {CATEGORIES.map((c) => (
            <button key={c} className={c === category ? 'seg-active' : ''} onClick={() => setCategory(c)}>
              {c}<Term t={CAT_GLOSS[c]} />
            </button>
          ))}
        </div>
        <label><Term t="timeframe" label="Таймфрейм" />
          <select name="timeframe" value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
            {INTERVALS.map((i) => <option key={i} value={i}>{INTERVAL_LABELS[i]}</option>)}
          </select>
        </label>
        <label>Монет
          <select name="limit" value={maxSymbols} onChange={(e) => setMaxSymbols(Number(e.target.value))}>
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label><Term t="confidence" label="Уверенность от" />
          <select name="minConf" value={minConf} onChange={(e) => setMinConf(Number(e.target.value))}>
            {CONF_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            name="safePairs"
            checked={safePairs}
            onChange={(e) => setSafePairs(e.target.checked)}
          />
          Отсеивать сомнительные<Term t="safePairs" />
        </label>
        <input className="search" name="search" placeholder="Поиск: BTC…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>Автообновление
          <select name="refresh" value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
            {REFRESH_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      {tickers.isPending && <p className="state">Загрузка монет ({category})…</p>}
      {tickers.isError && <p className="state err">Ошибка загрузки: {String(tickers.error instanceof Error ? tickers.error.message : tickers.error)}</p>}
      {!tickers.isPending && (
        <p className="state">
          Режим: <b className={real ? 'neg' : ''}>{real ? 'реальный' : 'бумажный'}</b>
          {' · '}{real ? 'вход ведёт на форму ордера /live' : 'вход виртуальный, деньги не двигаются'}
          {' · '}Монет: {tickers.data?.length ?? 0} · Сканируем: {scanned.length} · В анализе: {kept.length} · Сетапов: {setupCount} · Свечи {INTERVAL_LABELS[interval]} ×200
          {minConf > 0 ? ` · Фильтр: уверенность от ${minConf}%` : ''}
          {safePairs
            ? ` · Сомнительные отсеяны: ${scanned.length - kept.length}`
              + ` (без свечей ${scanned.length - tradable.length} · по свечам ${hidden.length}`
              + (hidden.length > 0
                ? `: вялый ход ${hiddenCounts.volatility}, маржа ${hiddenCounts.size}`
                : '')
              + ')'
            : ' · Сомнительные не отсеиваются'}
          {tradable.length > 0 && ` · Обновление свечей: ${describeRefresh(tradable.length, klineBudget, cycleMs)}`}
          {` · Автообновление: ${refreshSec === 0 ? 'выкл' : `каждые ${refreshLabel}`}`}
          {tickers.dataUpdatedAt > 0 ? ` · Обновлено: ${new Date(tickers.dataUpdatedAt).toLocaleTimeString()}` : ''}
          {klineLoading ? ' · подгрузка свечей…' : ''}{klineErrors > 0 ? ` · ошибок свечей: ${klineErrors}` : ''}
        </p>
      )}

      {entryMsg && (
        <p className={`state ${entryMsg.ok ? '' : 'err'}`}>
          {entryMsg.ok ? '✓ ' : '✕ '}
          <PairLink symbol={entryMsg.symbol} category={category} />{' · '}
          {entryMsg.text}
        </p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} onClick={() => toggleSort(c.key)} className="sortable">
                  <Term t={c.gloss} label={c.label} />{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.symbol} {...rowKeyProps(() => openSymbol(r.symbol), `Открыть план ${r.symbol}`)}>
                <td className="sym"><PairLink symbol={r.symbol} category={category} /></td>
                <td>{fmt(r.m?.lastPrice ?? r.price, r.price < 1 ? 5 : 2)}</td>
                <td>{fmtCompact(r.turnover)}</td>
                <td className={setupCls(r.direction)}>
                  {setupText(r.direction)}
                  {r.plan && r.plan.direction !== 'wait' && (
                    <button
                      type="button"
                      className={`btn btn-sm quick-entry${real ? ' real' : ''}`}
                      onClick={(e) => { e.stopPropagation(); entryAction(r); }}
                      title={real
                        ? 'Реальный режим: откроет форму ордера на /live (риск и плечо перенесутся). Ордер уходит только после подтверждения'
                        : 'Бумажный вход: лимитная заявка по середине зоны, размер от риска, текущие ставка/плечо. Позиция откроется, когда цена дойдёт до лимита. Реальные деньги не двигаются'}
                    >{real ? 'Реальный вход →' : 'Вход (бумага)'}</button>
                  )}
                  {r.plan && r.plan.direction !== 'wait' && (
                    <button
                      type="button"
                      className="btn btn-sm quick-entry quick-entry-market"
                      onClick={(e) => { e.stopPropagation(); marketEntryAction(r); }}
                      title={real
                        ? 'Реальный режим: откроет форму ордера на /live. Рыночный ордер отправляется только оттуда и только после подтверждения'
                        : 'Вход по рынку: исполнение сразу по текущей цене, без ожидания отката. Риск в $ тот же, дистанция до стопа больше. Проскальзывание в бумаге не учитывается'}
                    >{real ? 'Реальный →' : 'По рынку'}</button>
                  )}
                  {r.plan && r.plan.direction !== 'wait' && r.plan.riskDist > 0 && (
                    <span className="muted quick-margin">
                      риск {fmt(riskMoney)} $ · маржа ≈{fmt(riskMoney / r.plan.riskDist * r.plan.entryMid / lev, 0)} $
                    </span>
                  )}
                </td>
                <td>{r.confidence == null ? '—' : `${r.confidence}%`}</td>
                <td className="score">{r.direction === 'long' || r.direction === 'short' ? priorityOf(r) : '—'}</td>
                <td>{r.m ? fmt(r.m.volatilityRange) : (r.klineLoading ? '…' : '—')}</td>
                <td>{r.m ? fmt(r.m.volatilityStd) : '—'}</td>
                <td>{r.m ? fmt(r.m.atrPct) : '—'}</td>
                <td className={numCls(r.m?.changePct)}>{r.m ? fmtPct(r.m.changePct) : '—'}</td>
                <td className={numCls(r.m?.momentumPct)}>{r.m ? fmtPct(r.m.momentumPct) : '—'}</td>
                <td className={numCls(r.m?.trendSlopePct)}>{r.m ? fmtPct(r.m.trendSlopePct) : '—'}</td>
                <td>{r.m ? fmt(r.m.rsi, 1) : '—'}</td>
                <td>{r.m ? `${fmt(r.m.volumeRatio)}x` : '—'}</td>
                <td>{r.fundingRate === null ? '—' : `${fmt(r.fundingRate * 100, 4)}%`}</td>
                <td className="score">{r.m ? fmt(r.m.score) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && !tickers.isPending && (
          <p className="state">{minConf > 0 ? `Нет сетапов с уверенностью от ${minConf}%. Снизь порог.` : 'Ничего не найдено.'}</p>
        )}
      </div>

      <footer className="foot">
        Данные: публичный API Bybit V5 (тикеры + свечи). Метрики и план считаются в браузере по 200 свечам выбранного таймфрейма.
        Скор = |тренд|·(0,3+R²) + волат.·0,3 + min(|импульс|,20)·0,2. Клик по строке — торговый план.
        Приоритет = уверенность + чистота/сила тренда + объём − штрафы (перегрев RSI, растянутая серия, слабый объём, шорты).
      </footer>
    </div>
  );
}
