import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_MODE, MODE_EVENT, MODE_KEY, isTradeMode, parseMode, type TradeMode } from '../lib/tradeMode';

function readStored(): TradeMode {
  try {
    return parseMode(sessionStorage.getItem(MODE_KEY));
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Режим торговли вкладки: sessionStorage + событие, чтобы переключатель в шапке
 * сразу менял поведение кнопок входа во всех компонентах (как CREDENTIALS_EVENT).
 */
export function useTradingMode(): [TradeMode, (m: TradeMode) => void] {
  const [mode, setState] = useState<TradeMode>(readStored);

  useEffect(() => {
    const reload = () => setState(readStored());
    window.addEventListener(MODE_EVENT, reload);
    return () => window.removeEventListener(MODE_EVENT, reload);
  }, []);

  const set = useCallback((next: TradeMode) => {
    if (!isTradeMode(next)) return;
    try {
      sessionStorage.setItem(MODE_KEY, JSON.stringify(next));
    } catch {
      /* приватный режим — работаем без персиста */
    }
    setState(next);
    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);

  return [mode, set];
}
