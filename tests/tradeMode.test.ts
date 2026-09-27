import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODE,
  MODE_HINTS,
  MODE_KEY,
  MODE_LABEL,
  REAL_MODE_CONFIRM,
  effectiveMode,
  isRealContext,
  isTradeMode,
  liveHref,
  parseLiveLink,
  parseMode,
} from '../src/lib/tradeMode';

describe('режим торговли', () => {
  it('по умолчанию — бумажный: реальные деньги нельзя задеть случайным кликом', () => {
    expect(DEFAULT_MODE).toBe('paper');
    expect(parseMode(null)).toBe('paper');
    expect(MODE_KEY.length).toBeGreaterThan(0);
  });

  it('parseMode: мусор и повреждённый JSON — бумажный режим', () => {
    expect(parseMode('"real"')).toBe('real');
    expect(parseMode('"paper"')).toBe('paper');
    expect(parseMode('"live"')).toBe('paper');
    expect(parseMode('7')).toBe('paper');
    expect(parseMode('{broken')).toBe('paper');
    expect(isTradeMode('real')).toBe(true);
    expect(isTradeMode(null)).toBe(false);
  });

  it('страницы реального счёта задают режим сами собой', () => {
    expect(isRealContext('/live')).toBe(true);
    expect(isRealContext('/real')).toBe(true);
    expect(isRealContext('/')).toBe(false);
    expect(isRealContext('/paper')).toBe(false);
    expect(isRealContext('/s/linear/APEUSDT')).toBe(false);

    expect(effectiveMode('paper', '/live')).toBe('real');
    expect(effectiveMode('real', '/real')).toBe('real');
    expect(effectiveMode('paper', '/')).toBe('paper');
    expect(effectiveMode('real', '/')).toBe('real');
  });

  it('реальный режим требует подтверждения и объясняет, что произойдёт', () => {
    expect(REAL_MODE_CONFIRM).toContain('/live');
    expect(REAL_MODE_CONFIRM).toContain('деньги настоящие');
    expect(MODE_HINTS.paper).toContain('виртуальные');
    expect(MODE_HINTS.real).toContain('реального ордера');
    expect(MODE_LABEL.paper).toBe('Бумага');
    expect(MODE_LABEL.real).toBe('Реально');
  });

  it('ссылка на реальный вход из скринера/плана и её разбор', () => {
    expect(liveHref('apeusdt', '5')).toBe('/live?symbol=APEUSDT&interval=5');
    expect(liveHref('BTCUSDT', '15')).toBe('/live?symbol=BTCUSDT&interval=15');

    expect(parseLiveLink('?symbol=apeusdt&interval=5')).toEqual({ symbol: 'APEUSDT', interval: '5' });
    // Прямой заход на /live без параметров — символ пустой, ТФ не задан.
    expect(parseLiveLink('')).toEqual({ symbol: '', interval: null });
    expect(parseLiveLink('?interval=')).toEqual({ symbol: '', interval: null });
  });
});
