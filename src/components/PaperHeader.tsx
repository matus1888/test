import { Link, useLocation } from 'react-router-dom';
import { usePaperPositions } from '../hooks/usePaper';
import { useApiAccount } from '../hooks/useApiAccount';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import { usePublicWsLive } from '../lib/tickerStore';
import { useTradingMode } from '../hooks/useTradingMode';
import { totalPnlOf } from '../lib/paper';
import { effectiveMode } from '../lib/tradeMode';
import { fmt, fmtCompact } from '../lib/format';
import Term from './Term';
import WsBadge from './WsBadge';
import TradeModeSwitch from './TradeModeSwitch';
import InstallButton from './InstallButton';

/** Округлённое число с группировкой разрядов (ru), например «7 463». */
const fmtInt = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v);

/**
 * Верхняя плашка: навигация, переключатель режима «Бумага ⇄ Реально» и портфель
 * того режима, в котором мы сейчас. Портфель не подменяется молча: подпись всегда
 * называет, чей это счёт — бумажный или реальный Bybit.
 */
export default function PaperHeader() {
  const { pathname } = useLocation();
  const api = useApiAccount();
  const [mode] = useTradingMode();
  const shown = effectiveMode(mode, pathname);
  const { positions } = usePaperPositions();
  const open = positions.filter((p) => p.status === 'open');
  // Заявки в рынке — не позиции: у них нет P&L, но они видны пользователю.
  const pending = positions.filter((p) => p.status === 'pending');
  const groups = groupByCategory([...open, ...pending]);
  const prices = useLivePrices(groups);
  const paperWs = usePublicWsLive(groups.map((g) => g.category));

  let unreal = 0;
  let engaged = 0;
  for (const p of open) {
    const r = totalPnlOf(p, prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice);
    unreal += r.net;
    engaged += r.margin; // задействованный капитал = суммарная маржа открытых (номинал/плечо)
  }
  let realized = 0;
  for (const p of positions) {
    if (p.status === 'closed') realized += totalPnlOf(p, p.closePrice ?? p.entryPrice).net;
  }
  const total = unreal + realized;
  const cls = total > 0 ? 'pos' : total < 0 ? 'neg' : '';

  const acc = api.account;
  const live = api.state === 'on' && acc != null;
  const used = acc ? acc.wallet.totalInitialMargin : 0;

  return (
    <div className="topbar">
      <Link to="/" className="brand">Скринер Bybit</Link>
      <div className="topbar-right">
        <Link to="/paper" className="api-link" title="Бумажный портфель: виртуальные сделки, P&L и разбор позиций">Бумага</Link>
        <Link to="/live" className="api-link" title="Реальная торговля Bybit: план → ордер, позиции, активные ордера">Реально</Link>
        <Link to="/api" className="api-link" title="Подключение API Bybit: ключ, баланс и позиции">API</Link>
        <Link to="/account" className="api-link" title="Личный кабинет: быстрый доступ и статусы">Кабинет</Link>
        <button
          type="button"
          className="api-link"
          title="Обзор приложения (walkthrough)"
          onClick={() => window.dispatchEvent(new Event('open-walkthrough'))}
        >?</button>
        <InstallButton />
        <TradeModeSwitch />
        {shown === 'real' ? (
          live ? (
            <Link
              to="/real"
              className="pf-chip real"
              title={`Реальный счёт Bybit (${api.testnet ? 'тестнет' : 'мейннет'}) · equity, маржа и позиции из API`}
            >
              <Term t="realTrading" label="Реальный счёт" />{' '}
              <b>{fmtCompact(acc.wallet.totalEquity)} $</b>
              <span className="muted"> · uP&L {acc.wallet.totalPerpUPL >= 0 ? '+' : ''}{fmt(acc.wallet.totalPerpUPL, 0)} $</span>
              <span className="muted"> · {acc.positions.length} поз.</span>
              <span className="muted"> · <Term t="margin" label="Занято" /> {fmtInt(used)} $</span>
            </Link>
          ) : (
            <Link to="/api" className="pf-chip real" title="Реальные ордера требуют ключ Bybit — подключить на странице /api">
              <Term t="realTrading" label="Реальный счёт" /> <b>ключи не подключены →</b>
            </Link>
          )
        ) : (
          <Link to="/paper" className="pf-chip paper" title="Бумажный портфель: P&L, открытые сделки и задействованный капитал">
            <Term t="paperTrading" label="Бумажный портфель" />{' '}
            <b className={cls}>{total >= 0 ? '+' : ''}{fmt(total)} $</b>
            <span className="muted"> · {open.length} откр.</span>
            {pending.length > 0 && <span className="muted"> · {pending.length} лим.</span>}
            <span className="muted"> · <Term t="margin" label="Задействовано" /> {fmtInt(engaged)} $</span>
          </Link>
        )}
        {shown === 'real' ? <WsBadge state={api.ws} testnet={api.testnet} /> : <WsBadge state={paperWs} />}
      </div>
    </div>
  );
}
