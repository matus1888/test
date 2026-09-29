import { useLocation } from 'react-router-dom';
import { useTradingMode } from '../hooks/useTradingMode';
import { MODE_LABEL, REAL_MODE_CONFIRM, isRealContext, type TradeMode } from '../lib/tradeMode';
import Term from './Term';
import { useConfirm } from './Confirm';

/**
 * Переключатель «Бумага ⇄ Реально» в шапке. На страницах реального счёта (/live, /real)
 * переключать нечего — там статичная метка «Реальные деньги».
 */
export default function TradeModeSwitch() {
  const { pathname } = useLocation();
  const [mode, setMode] = useTradingMode();
  const [confirm, confirmDialog] = useConfirm();

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

  const ask = async (next: TradeMode) => {
    if (next === 'real') {
      const ok = await confirm({ title: 'Включить реальный режим?', text: REAL_MODE_CONFIRM, ok: 'Включить', danger: true });
      if (!ok) return;
    }
    setMode(next);
  };

  return (
    <div className="mode-switch">
      {confirmDialog}
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
