import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApiAccount } from '../hooks/useApiAccount';
import { useTradingMode } from '../hooks/useTradingMode';
import { MODE_HINTS, effectiveMode, isRealContext } from '../lib/tradeMode';

/** Сеть и ключи — одна и та же подсказка для обоих реальных режимов. */
function RealStatus({ testnet, hasKeys }: { testnet: boolean; hasKeys: boolean }) {
  return (
    <span className="mode-bar-status">
      {' · сеть '}
      <b className={testnet ? '' : 'neg'}>{testnet ? 'ТЕСТНЕТ' : 'МЕЙННЕТ'}</b>
      {hasKeys ? '' : <> · <Link to="/api">ключи не подключены</Link></>}
    </span>
  );
}

/**
 * Полоса под шапкой: всегда отвечает на вопрос «где я сейчас торгую».
 * Бумага — синяя, реальные деньги — красная. На /live и /real режим задан страницей.
 */
export default function TradeModeBar() {
  const { pathname } = useLocation();
  const [mode] = useTradingMode();
  const api = useApiAccount();
  const shown = effectiveMode(mode, pathname);
  const real = shown === 'real';

  // Акцент темы для CSS (цвет кнопок входа) — один раз на смену режима.
  useEffect(() => {
    document.body.dataset.mode = shown;
  }, [shown]);

  const link = isRealContext(pathname)
    ? <Link to="/paper">бумажный портфель →</Link>
    : <Link to="/live">реальная торговля →</Link>;

  const text = pathname === '/live'
    ? 'Здесь ордера всегда отправляются на Bybit — деньги настоящие.'
    : pathname === '/real'
      ? 'Реальный счёт по API: капитал, маржа, позиции и активные ордера биржи.'
      : MODE_HINTS[shown];

  return (
    <div className={`mode-bar ${real ? 'real' : 'paper'}`} role="status">
      <b>{pathname === '/real' ? 'РЕАЛЬНЫЙ СЧЁТ' : real ? 'РЕАЛЬНЫЙ РЕЖИМ' : 'БУМАЖНЫЙ РЕЖИМ'}</b>
      <span className="mode-bar-text"> · {text}</span>
      {real && <RealStatus testnet={api.testnet} hasKeys={api.state !== 'none'} />}
      <span className="mode-bar-link"> · {link}</span>
    </div>
  );
}
