/**
 * Глобальный режим торговли — единственный переключатель «бумага / реально».
 *
 * «Бумага» (по умолчанию): кнопки входа в скринере и на странице символа открывают
 * виртуальные позиции, реальные деньги не двигаются.
 * «Реально»: те же кнопки ведут на форму реального ордера (/live). Сам ордер
 * отправляется только со страницы /live и только после подтверждения — случайный
 * клик в таблице деньги не тратит.
 *
 * На страницах реального счёта (/live, /real) режим задан самой страницей:
 * переключатель там не нужен, там всё настоящее.
 */

export type TradeMode = 'paper' | 'real';

export const MODE_KEY = 'trade:mode';
export const MODE_EVENT = 'trade:mode:changed';

export const isTradeMode = (v: unknown): v is TradeMode => v === 'paper' || v === 'real';

/** Без явного выбора — бумажный режим: реальные деньги нельзя задеть случайным кликом. */
export const DEFAULT_MODE: TradeMode = 'paper';

export const MODE_LABEL: Record<TradeMode, string> = { paper: 'Бумага', real: 'Реально' };

/** Страницы, где торгуют настоящими деньгами: переключатель режима на них не показываем. */
export function isRealContext(pathname: string): boolean {
  return pathname === '/live' || pathname === '/real';
}

/** Режим, который видит пользователь: на страницах реального счёта — всегда «Реально». */
export function effectiveMode(stored: TradeMode, pathname: string): TradeMode {
  return isRealContext(pathname) ? 'real' : stored;
}

/** Значение из sessionStorage; мусор и повреждённый JSON — бумажный режим. */
export function parseMode(raw: string | null): TradeMode {
  if (raw == null) return DEFAULT_MODE;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTradeMode(parsed) ? parsed : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** Подтверждение при включении реального режима — намеренное действие, не один клик. */
export const REAL_MODE_CONFIRM =
  'Включить режим «Реально»?\n\n'
  + 'Кнопки входа в скринере и на странице символа будут открывать форму реального '
  + 'ордера Bybit — деньги настоящие. Сам ордер отправляется только со страницы /live '
  + 'и только после галочки «реальные деньги» на мейннете.\n\n'
  + 'Вернуть бумажный режим — переключатель в шапке.';

/** Пояснение под полосой режима: что именно делают кнопки входа сейчас. */
export const MODE_HINTS: Record<TradeMode, string> = {
  paper: 'Входы виртуальные: реальные деньги не двигаются, сделки считаются по живому рынку.',
  real: 'Кнопки входа открывают форму реального ордера Bybit — деньги настоящие.',
};

/** Ссылка «перейти к реальному входу» из скринера и плана символа. */
export function liveHref(symbol: string, interval: string, kind: 'limit' | 'market' = 'limit'): string {
  const s = symbol.trim().toUpperCase();
  const kindParam = kind === 'market' ? '&kind=market' : '';
  return `/live?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}${kindParam}`;
}

/** Символ и таймфрейм из такой ссылки — предзаполнение формы реального ордера. */
export function parseLiveLink(search: string): { symbol: string; interval: string | null } {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const symbol = (params.get('symbol') ?? '').trim().toUpperCase();
  const interval = (params.get('interval') ?? '').trim();
  return { symbol, interval: interval || null };
}
