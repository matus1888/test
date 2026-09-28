import Term from './Term';
import type { WsFeed } from '../lib/tickerStore';

const TEXT: Record<WsFeed, string> = {
  live: 'поток live',
  connecting: 'сокет: подключение',
  down: 'сокет: переподключение, данные из REST',
  off: 'сокет не подключён',
};

/**
 * Метка состояния WebSocket. Пока поток не поднялся, интерфейс продолжает работать
 * на REST-опросе — метка показывает именно это, а не «ошибку».
 */
export default function WsBadge({ state, testnet = false }: { state: WsFeed; testnet?: boolean }) {
  if (state === 'off') return null;
  return (
    <span className={`ws-badge ${state}`}>
      <i aria-hidden="true" />
      <Term t="wsLive" label={TEXT[state]} />
      {testnet ? ' · тестнет' : ''}
    </span>
  );
}
