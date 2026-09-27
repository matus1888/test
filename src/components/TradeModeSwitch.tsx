import { useLocation } from 'react-router-dom';
import { useTradingMode } from '../hooks/useTradingMode';
import { MODE_LABEL, REAL_MODE_CONFIRM, isRealContext, type TradeMode } from '../lib/tradeMode';
import Term from './Term';

/**
 * Переключатель «Бумага ⇄ Реально» в шапке. На страницах реального счёта (/live, /real)
 * переключать нечего — там статичная метка «Реальные деньги».
 */
export default function TradeModeSwitch() {
  const { pathname } = useLocation();
  const [mode, setMode] = useTradingMode();

  if (isRealContext(pathname)) {
    return (
      <span
        className="env-badge real"
        title="Страница реального счёта: здесь всё настоящее, переключатель режима не нужен"
      >
        <Term t="realTrading" label="Реальные деньги" />
      </span>
    );
  }

  const ask = (next: TradeMode) => {
    if (next === 'real' && !window.confirm(REAL_MODE_CONFIRM)) return;
    setMode(next);
  };

  return (
    <div className="mode-switch">
      <Term t="tradeMode" label="Режим" />
      <div className="seg mode-seg" role="group" aria-label="Режим торговли: бумажный или реальный">
        {(['paper', 'real'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={`${mode === m ? 'seg-active' : ''}${m === 'real' ? ' mode-real' : ''}`}
            onClick={() => ask(m)}
          >{MODE_LABEL[m]}</button>
        ))}
      </div>
    </div>
  );
}
