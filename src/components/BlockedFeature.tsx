import { Link } from 'react-router-dom';

export type BlockedKind = 'api' | 'live' | 'bot';

const DATA: Record<BlockedKind, { title: string; what: string; why: string }> = {
  api: {
    title: 'Подключение API Bybit — недоступно',
    what: 'Подключение ключей Bybit и проверка соединения',
    why: 'Bybit не выдаёт ключи тестнета в этом регионе, а работа мейннета не проверена на реальном исполнении.',
  },
  live: {
    title: 'Реальная торговля — недоступна',
    what: 'Исполнение ордеров на Bybit',
    why: 'Тестнет недоступен для проверки, мейннет не подтверждён реальной сделкой — рисковать реальными деньгами без проверки нельзя.',
  },
  bot: {
    title: 'Telegram-бот — недоступен',
    what: 'Локальный Go-бот и его кнопочная торговля',
    why: 'Бот не работает: Telegram- и Bybit-эндпоинты недоступны из этого региона, проверить и починить его здесь нельзя.',
  },
};

/** Заглушка для функций, отключённых из-за региональных ограничений. */
export default function BlockedFeature({ kind }: { kind: BlockedKind }) {
  const d = DATA[kind];
  return (
    <div className="page">
      <Link to="/" className="back">← К скринеру</Link>
      <header className="top">
        <div>
          <h1>{d.title}</h1>
          <p className="sub">{d.what} отключена в этом интерфейсе.</p>
        </div>
      </header>

      <section className="cards">
        <div className="card">
          <h3>Почему недоступно</h3>
          <p className="state">{d.why}</p>
          <p className="muted">
            Работают: скринер, торговые планы и бумажный портфель — они считаются на публичных данных Bybit
            и не требуют ключей.
          </p>
          <div className="controls">
            <Link to="/" className="btn">Скринер</Link>
            <Link to="/paper" className="btn">Бумажный портфель</Link>
          </div>
        </div>
      </section>

      <footer className="foot">
        Функция вернётся в интерфейс после снятия региональных ограничений.
      </footer>
    </div>
  );
}
