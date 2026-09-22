import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { useSessionState } from '../hooks/useSessionState';
import { fmt, fmtCompact, fmtPct } from '../lib/format';
import { numCls, setupCls, setupText } from '../lib/ui';
import { CAT_GLOSS, CONF_OPTIONS, REFRESH_OPTIONS } from '../lib/options';
import {
  COLUMNS,
  buildRows,
  filterByConfidence,
  sortRows,
  type SortKey,
} from '../lib/screener';
import Term from '../components/Term';

const isLimit = (v: unknown): v is number =>
  typeof v === 'number' && [25, 50, 100, 200].includes(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isSortKey = (v: unknown): v is SortKey =>
  typeof v === 'string' && COLUMNS.some((c) => c.key === v);
const isSortDir = (v: unknown): v is 1 | -1 => v === 1 || v === -1;
const isRefresh = (v: unknown): v is number =>
  typeof v === 'number' && [0, 15, 30, 60, 120, 300, 50, 70, 80, 90].includes(v);

export default function ScreenerPage() {
  const navigate = useNavigate();
  const [category, setCategory] = useSessionState<Category>('screener:category', 'linear', isCategory);
  const [interval, setInterval] = useSessionState<Interval>('screener:interval', '5', isInterval);
  const [maxSymbols, setMaxSymbols] = useSessionState<number>('screener:limit', 50, isLimit);
  const [search, setSearch] = useSessionState<string>('screener:search', '', isString);
  const [sortKey, setSortKey] = useSessionState<SortKey>('screener:sortKey', 'score', isSortKey);
  const [sortDir, setSortDir] = useSessionState<1 | -1>('screener:sortDir', -1, isSortDir);
  const [refreshSec, setRefreshSec] = useSessionState<number>('screener:refresh', 60, isRefresh);
  const [minConf, setMinConf] = useSessionState<number>('screener:minConf', 80, isRefresh);

  const refreshMs = refreshSec === 0 ? false : refreshSec * 1000;
  const tickers = useTickers(category, refreshMs);

  const symbols = useMemo(() => {
    const list = tickers.data ?? [];
    const q = search.trim().toUpperCase();
    const filtered = q ? list.filter((t) => t.symbol.includes(q)) : list;
    return [...filtered]
      .sort((a, b) => b.turnover24h - a.turnover24h)
      .slice(0, maxSymbols)
      .map((t) => t.symbol);
  }, [tickers.data, search, maxSymbols]);

  const klines = useKlines(category, symbols, interval, 200, (tickers.data?.length ?? 0) > 0, refreshMs);

  const rows = useMemo(
    () => buildRows(symbols, tickers.data ?? [], klines, category, interval),
    [symbols, tickers.data, klines, category, interval],
  );
  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);
  // Фильтр по уверенности: только направленные сетапы с уверенностью не ниже порога
  const visible = useMemo(() => filterByConfidence(sorted, minConf), [sorted, minConf]);
  const setupCount = rows.filter((r) => r.direction === 'long' || r.direction === 'short').length;

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === 'symbol' ? 1 : -1); }
  };

  const openSymbol = (s: string) => {
    navigate(`/s/${category}/${encodeURIComponent(s)}?interval=${interval}`);
  };

  const klineLoading = klines.some((k) => k.loading);
  const klineErrors = klines.filter((k) => k.error).length;
  const refreshLabel = REFRESH_OPTIONS.find((o) => o.value === refreshSec)?.label ?? '';

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Скринер Bybit</h1>
          <p className="sub">Публичные данные Bybit V5 · ранжирование монет по волатильности и тренду</p>
        </div>
        <button className="btn" onClick={() => tickers.refetch()} disabled={tickers.isFetching}>
          {tickers.isFetching ? 'Обновление…' : 'Обновить'}
        </button>
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
          Монет: {tickers.data?.length ?? 0} · В анализе: {symbols.length} · Сетапов: {setupCount} · Свечи {INTERVAL_LABELS[interval]} ×200
          {minConf > 0 ? ` · Фильтр: уверенность от ${minConf}%` : ''}
          {` · Автообновление: ${refreshSec === 0 ? 'выкл' : `каждые ${refreshLabel}`}`}
          {tickers.dataUpdatedAt > 0 ? ` · Обновлено: ${new Date(tickers.dataUpdatedAt).toLocaleTimeString()}` : ''}
          {klineLoading ? ' · подгрузка свечей…' : ''}{klineErrors > 0 ? ` · ошибок свечей: ${klineErrors}` : ''}
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
              <tr key={r.symbol} onClick={() => openSymbol(r.symbol)}>
                <td className="sym">{r.symbol}</td>
                <td>{fmt(r.m?.lastPrice ?? r.price, r.price < 1 ? 5 : 2)}</td>
                <td>{fmtCompact(r.turnover)}</td>
                <td className={setupCls(r.direction)}>{setupText(r.direction)}</td>
                <td>{r.confidence == null ? '—' : `${r.confidence}%`}</td>
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
      </footer>
    </div>
  );
}
