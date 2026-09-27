import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePaperPositions } from '../hooks/usePaper';
import { useApiAccount } from '../hooks/useApiAccount';
import { groupByCategory, useLivePrices } from '../hooks/useLivePrices';
import { totalPnlOf } from '../lib/paper';
import { WALKTHROUGH_KEY, shouldAutoOpen } from '../lib/guide';
import { fmt } from '../lib/format';
import Term from '../components/Term';

interface DashLink {
  route: string;
  title: string;
  desc: string;
}

const LINKS: DashLink[] = [
  { route: '/', title: 'Скринер', desc: 'Ранжирование монет по приоритету, фильтры и быстрый вход.' },
  { route: '/paper', title: 'Бумажный портфель', desc: 'P&L, открытые позиции, лесенка и разбор сделок.' },
  { route: '/real', title: 'Портфель Bybit', desc: 'Реальный счёт по API: капитал, маржа, позиции и активные ордера.' },
  { route: '/api', title: 'Подключение API', desc: 'Ключ Bybit, баланс и позиции; локально ключи берутся из .env.' },
  { route: '/live', title: 'Реальная торговля', desc: 'План → ордер, лесенка TP1/2/3, безубыток и закрытие по рынку.' },
];

/** Личный кабинет: быстрый доступ к разделам, статусы и управление обучением. */
export default function AccountPage() {
  const [learning, setLearningState] = useState(() => shouldAutoOpen());
  const api = useApiAccount();
  const { positions } = usePaperPositions();
  const open = positions.filter((p) => p.status === 'open');
  const prices = useLivePrices(groupByCategory(open));

  let net = 0;
  let engaged = 0;
  for (const p of positions) {
    const r = totalPnlOf(p, p.status === 'open' ? (prices.get(`${p.category}:${p.symbol}`) ?? p.entryPrice) : (p.closePrice ?? p.entryPrice));
    net += r.net;
    // Задействованный капитал — только маржа открытых позиций (как в шапке).
    if (p.status === 'open') engaged += r.margin;
  }

  const toggleLearning = (on: boolean) => {
    try {
      if (on) localStorage.removeItem(WALKTHROUGH_KEY);
      else localStorage.setItem(WALKTHROUGH_KEY, '1');
    } catch {
      /* noop */
    }
    setLearningState(on);
  };

  const runNow = () => {
    window.dispatchEvent(new Event('open-walkthrough'));
  };

  return (
    <div className="page">
      <Link to="/" className="back">← К скринеру</Link>
      <header className="top">
        <div>
          <h1>Личный кабинет</h1>
          <p className="sub">Быстрый доступ к инструментам, статусы и обучение.</p>
        </div>
      </header>

      <section>
        <h3 className="sec-title">Быстрый доступ</h3>
        <div className="dash-grid">
          {LINKS.map((l) => (
            <Link key={l.route} to={l.route} className="card dash-card">
              <b>{l.title}</b>
              <span className="state">{l.desc}</span>
              <span className="muted">Открыть →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="cards">
        <div className="card">
          <h3>Обучение (walkthrough)</h3>
          <label className="apiform">
            <input type="checkbox" checked={learning} onChange={(e) => toggleLearning(e.target.checked)} />
            Показывать обзор при запуске
          </label>
          <p className="state">Проходит по основным страницам: скринер, режим бумага/реально, планы, бумажный портфель, подключение API и реальная торговля.</p>
          <div className="controls">
            <button className="btn open-long" onClick={runNow}>Пройти сейчас</button>
          </div>
        </div>

        <div className="card">
          <h3><Term t="paperTrading" label="Бумажный портфель" /></h3>
          <div className="lvl"><span>Общий P&L</span><b className={net >= 0 ? 'pos' : net < 0 ? 'neg' : ''}>{net >= 0 ? '+' : ''}{fmt(net)} $</b></div>
          <div className="lvl"><span>Открытых</span><b>{open.length}</b></div>
          <div className="lvl"><span>Задействовано</span><b>{fmt(engaged)} $</b></div>
        </div>

        <div className="card">
          <h3>Реальный счёт</h3>
          {api.state === 'none' ? (
            <div className="lvl">
              <span>API</span>
              <b className="muted"><Link to="/api">не подключён</Link></b>
            </div>
          ) : api.state === 'on' && api.account ? (
            <>
              <div className="lvl">
                <span>Сеть</span>
                <b>{api.testnet ? 'тестнет' : 'мейннет'}</b>
              </div>
              <div className="lvl">
                <span>Equity</span>
                <b>{fmt(api.account.wallet.totalEquity, 2)} $</b>
              </div>
              <div className="lvl">
                <span>Позиций / ордеров</span>
                <b>{api.account.positions.length} / {api.account.orders.length}</b>
              </div>
              <div className="lvl">
                <span>Занято маржой</span>
                <b>{fmt(api.account.wallet.totalInitialMargin, 2)} $</b>
              </div>
            </>
          ) : (
            <div className="lvl">
              <span>API</span>
              <b className="neg">{api.state === 'error' ? `ошибка: ${api.error}` : 'проверяю…'}</b>
            </div>
          )}
          <div className="controls">
            <Link to="/real" className="btn btn-sm">Открыть портфель</Link>
          </div>
        </div>
      </section>

      <footer className="foot">
        Личный кабинет — только навигация и статусы; торговля и настройки живут на своих страницах.
      </footer>
    </div>
  );
}