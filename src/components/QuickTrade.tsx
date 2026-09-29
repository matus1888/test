import { Link } from 'react-router-dom';
import { PlusIcon } from './icons';
import Term from './Term';
import { fmt, fmtCompact, fmtPct } from '../lib/format';
import type { PaperDirection } from '../lib/paper';

const STAKES = [25, 50, 100, 250];
const LEVS = [1, 2, 3, 5, 10, 20];

interface Props {
  direction: PaperDirection;
  entryPrice: number;
  decimals: number;
  stake: number;
  setStake: (v: number) => void;
  lev: number;
  setLev: (v: number) => void;
  qty: number;
  deposit: number;
  riskPct: number;
  setRiskPct: (v: number) => void;
  riskMoney: number;
  marginNeeded: number;
  blockReason: string | null;
  /** Цена входа по рынку (текущая котировка) и маржа под него. */
  marketPrice?: number;
  marketMargin?: number;
  /** Причина, по которой вход по рынку сейчас невозможен (нет цены, дубль, лимиты). */
  marketBlockReason?: string | null;
  liq?: number | null;
  liqRatio?: number | null;
  onOpen: () => void;
  /** Вход по рынку вместо лимита: исполнение сразу, без ожидания отката. */
  onOpenMarket?: () => void;
  /** Куда ведёт кнопка входа: бумажная позиция или форма реального ордера (/live). */
  realHref?: string;
}

/** Быстрый вход в один клик: риск в $, ставка/плечо, кнопка. Липкая, висит над графиком при скролле. */
export default function QuickTrade({
  direction, entryPrice, decimals, stake, setStake, lev, setLev, qty,
  deposit, riskPct, setRiskPct, riskMoney, marginNeeded, blockReason,
  marketPrice = 0, marketMargin = 0, marketBlockReason, liq, liqRatio, onOpen, onOpenMarket, realHref,
}: Props) {
  const long = direction === 'long';
  const real = realHref != null;
  const setRiskMoney = (v: number) => {
    if (deposit > 0 && Number.isFinite(v)) setRiskPct((v / deposit) * 100);
  };
  return (
    <div className="quick-trade">
      <span className={long ? 'setup-long' : 'setup-short'}>{long ? 'ЛОНГ' : 'ШОРТ'}</span>
      <Term t="risk" label="Риск, $" />
      <input
        name="quickRisk"
        type="number"
        min={0}
        step="any"
        value={Number.isFinite(riskMoney) ? riskMoney : 0}
        aria-label="Риск на сделку в долларах"
        onChange={(e) => setRiskMoney(Number(e.target.value))}
        onKeyDown={(e) => { if (e.key === 'Enter' && !blockReason && !real) onOpen(); }}
      />
      <span className="muted">({fmt(riskPct, 1)}% депо)</span>
      <Term t="stake" label="Ставка (потолок маржи)" />
      {STAKES.map((n) => (
        <button key={n} className={stake === n ? 'chip chip-active' : 'chip'} onClick={() => setStake(n)}>
          ${n}
        </button>
      ))}
      <input
        name="quickStake"
        type="number"
        min={1}
        value={stake}
        aria-label="Своя ставка в долларах"
        onChange={(e) => setStake(Number(e.target.value))}
        onKeyDown={(e) => { if (e.key === 'Enter' && !blockReason && !real) onOpen(); }}
      />
      <Term t="leverage" label="Плечо" />
      {LEVS.map((n) => (
        <button key={n} className={lev === n ? 'chip chip-active' : 'chip'} onClick={() => setLev(n)}>
          ×{n}
        </button>
      ))}
      <span className="muted">из депозита в этой сделке <b>{fmt(marginNeeded)} $</b>
        {deposit > 0 ? ` (${fmtPct((marginNeeded / deposit) * 100, 0)} депо)` : ''}
        {` · номинал ${fmtCompact(qty * entryPrice)} $ (×${lev} к марже) · ${fmt(qty, 4)} шт. по ~${fmt(entryPrice, decimals)}`}
        {liq != null ? ` · liq ~${fmt(liq, decimals)}${liqRatio != null ? ` (${liqRatio.toFixed(2)}x к стопу)` : ''}` : ''}
      </span>
      {real ? (
        <Link className="btn btn-danger quick-open-real" to={realHref}>
          <PlusIcon /> Реальный ордер →
        </Link>
      ) : (
        <>
          <button className={`btn ${long ? 'open-long' : 'open-short'}`} onClick={onOpen} disabled={blockReason != null}>
            <PlusIcon /> Открыть (бумага)
          </button>
          {/* Второй вход — сразу по текущей цене, без ожидания отката к лимиту. */}
          <button
            className="btn quick-open-market"
            onClick={onOpenMarket}
            disabled={!onOpenMarket || marketBlockReason != null}
            title={
              marketBlockReason ?? 'Исполнение сразу по текущей цене, без ожидания отката. В бумаге проскальзывание не учитывается'
            }
          >
            <PlusIcon /> <Term t="marketEntry" label="По рынку" />
          </button>
        </>
      )}
      {real ? (
        <span className="muted">Риск и плечо перенесутся на /live. Бумажный вход — переключи «Режим» в шапке на «Бумага».</span>
      ) : (
        <>
          {blockReason && <span className="muted">{blockReason}</span>}
          {!blockReason && marketPrice > 0 && (
            <span className="muted">
              По рынку: цена {fmt(marketPrice, decimals)} · маржа {fmt(marketMargin)} $
              {marketBlockReason && ` · ${marketBlockReason}`}
            </span>
          )}
        </>
      )}
    </div>
  );
}
