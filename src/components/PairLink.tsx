import type { Category } from '../api/bybit';
import { bybitTradeUrl } from '../api/bybit';
import { ExternalIcon } from './icons';

/**
 * Ссылка на торговлю пары на бирже Bybit — ставится рядом с каждым упоминанием пары
 * в интерфейсе (таблицы скринера и портфелей, заголовки страниц, позиции/ордера/исполнения
 * реального счёта). Один компонент, чтобы правило «у пары всегда есть ссылка на биржу»
 * не разъезжалось по страницам.
 *
 * Что важно:
 * - `bybitTradeUrl` возвращает `null` для опционов и нестандартных спот-пар — тогда
 *   показываем обычный текст без ссылки, а не битую кнопку;
 * - `stopPropagation` обязателен: символ лежит внутри кликабельной строки таблицы
 *   (`rowKeyProps` открывает план), и без остановки клик по ссылке ушёл бы в план;
 * - нативный `title` не используем (в приложении один тултип — свой, `Term`).
 */
export default function PairLink({
  symbol,
  category,
  withText = false,
  className,
}: {
  symbol: string;
  category: Category;
  /** Подпись «на бирже» рядом со значком — для заголовков, где важен сам факт ссылки. */
  withText?: boolean;
  className?: string;
}) {
  const url = bybitTradeUrl(category, symbol);
  if (!url) return <span className={className}>{symbol}</span>;

  const cls = ['pair-link', withText ? 'pair-link-text' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <a
      className={cls}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${symbol} — открыть торговлю на бирже Bybit`}
      onClick={(e) => e.stopPropagation()}
    >
      {symbol}
      <ExternalIcon />
      {withText && <>{' '}<span className="pair-link-note">на бирже</span></>}
    </a>
  );
}
