import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearCredentials,
  devCredentials,
  hasStoredCredentials,
  saveCredentials,
  type ApiCredentials,
} from '../api/privateApi';
import { useApiAccount } from '../hooks/useApiAccount';
import { fmt, fmtCompact } from '../lib/format';
import Term from '../components/Term';

const MAX_COINS = 8;

/** Страница подключения к реальному API Bybit (ключ/секрет хранятся в браузере). */
export default function ApiPage() {
  // Проверка подключения и снимок счёта — общий хук (он же крутит шапку и /real).
  const api = useApiAccount();
  // Ключи из .env подставляются только локальным dev-сервером (vite.config.ts, devBybitKeys).
  const [dev] = useState<ApiCredentials | null>(() => devCredentials());
  const [key, setKey] = useState(() => dev?.key ?? '');
  const [secret, setSecret] = useState(() => dev?.secret ?? '');
  const [testnet, setTestnet] = useState(() => dev?.testnet ?? false);
  const [formError, setFormError] = useState<string | null>(null);

  const cred = api.cred;
  const info = api.account;
  const busy = api.isFetching;
  const error = formError ?? (cred && !info ? api.error : null);
  const fromEnv = dev != null && !hasStoredCredentials();

  const saveAndCheck = () => {
    const k = key.trim();
    const s = secret.trim();
    if (!k || !s) {
      setFormError('Введи API-ключ и секрет.');
      return;
    }
    setFormError(null);
    // Ключи из .env не сохраняем без явного действия пользователя.
    if (dev == null || k !== dev.key || s !== dev.secret || testnet !== dev.testnet) {
      saveCredentials({ key: k, secret: s, testnet });
    }
    api.reload();
  };

  const remove = () => {
    clearCredentials();
    setFormError(null);
    setKey(dev?.key ?? '');
    setSecret(dev?.secret ?? '');
    setTestnet(dev?.testnet ?? false);
  };

  const reusableCoins = (info?.wallet.coins ?? []).filter((c) => c.usdValue > 0).slice(0, MAX_COINS);

  return (
    <div className="page">
      <Link to="/" className="back">← Назад к скринеру</Link>
      <header className="top">
        <div>
          <h1>Подключение к бирже (API Bybit V5)</h1>
          <p className="sub">Ключ и секрет хранятся только в твоём браузере. Секрет не отправляется никуда кроме api.bybit.com (подпись HMAC-SHA256).</p>
        </div>
      </header>

      <section className="cards">
        <div className="card">
          <h3>Статус</h3>
          <div className="lvl">
            <span>Ключ</span>
            <b>
              {cred
                ? fromEnv
                  ? `${cred.testnet ? 'Тестнет' : 'Мейннет'} · из .env${info ? ' · проверен' : ''}`
                  : cred.testnet ? 'Тестнет · настроен' : 'Мейннет · настроен'
                : 'Не настроен'}
            </b>
          </div>
          {cred && (
            <div className="lvl"><span>API-key</span><b className="muted">{cred.key.slice(0, 8)}…{cred.key.slice(-4)}</b></div>
          )}
          {fromEnv && (
            <div className="lvl"><span>Источник</span><b className="muted">.env (локальный dev-сервер) · подключение проверяется автоматически</b></div>
          )}
        </div>
        {!cred ? (
          <div className="card apiform">
            <h3>Ввод ключей</h3>
            <label>API Key
              <input name="apiKey" type="text" autoComplete="off" value={key} placeholder="Z7... (публичная часть)" onChange={(e) => setKey(e.target.value)} />
            </label>
            <label>API Secret
              <input name="apiSecret" type="password" autoComplete="off" value={secret} placeholder="только подпись, хранится в браузере" onChange={(e) => setSecret(e.target.value)} />
            </label>
            <label>Сеть
              <select name="apiNet" value={testnet ? 1 : 0} onChange={(e) => setTestnet(e.target.value === '1')}>
                <option value={0}>Мейннет (реальные деньги)</option>
                <option value={1}>Тестнет (api-testnet.bybit.com)</option>
              </select>
            </label>
            <div className="controls">
              <button className="btn" onClick={saveAndCheck} disabled={busy}>
                {busy ? 'Проверка…' : 'Сохранить и проверить'}
              </button>
            </div>
            {dev && (
              <p className="state">
                Ключи подставлены из <b>.env</b> (API_KEY / API_SECRET / API_TESTNET) — это работает только
                на локальном dev-сервере, в сборку они не попадают. Можно изменить значения в полях.
              </p>
            )}
            <p className="state err-note">
              ⚠️ Для реальных денег используй API-ключ <b>без права вывода</b> и с ограничением по IP.
              Для отладки безопаснее тестнет.
            </p>
          </div>
        ) : (
          <div className="card">
            <h3>Действия</h3>
            <div className="controls">
              <button className="btn" onClick={api.reload} disabled={busy}>
                {busy ? 'Проверка…' : 'Проверить подключение'}
              </button>
              <button className="btn btn-danger" onClick={remove}>Удалить ключи</button>
            </div>
            {dev && <p className="muted">После удаления ключи из <b>.env</b> подставятся снова — это поведение нужно только локально.</p>}
          </div>
        )}
      </section>

      {error && <p className="state err">{error}</p>}

      {info && (
        <>
          <section className="cards">
            <div className="card">
              <h3>Баланс ({info.wallet.accountType})</h3>
              <div className="lvl"><span>Equity</span><b>{fmtCompact(info.wallet.totalEquity)} $</b></div>
              <div className="lvl"><span>Кошелёк</span><b>{fmtCompact(info.wallet.totalWalletBalance)} $</b></div>
              <div className="lvl"><span>Маржа</span><b>{fmtCompact(info.wallet.totalMarginBalance)} $</b></div>
            </div>
            <div className="card">
              <h3>Открытые позиции (linear)</h3>
              <div className="lvl"><span>Кол-во</span><b>{info.positions.length}</b></div>
              <div className="lvl"><span>Нереализ. P&L</span><b className={info.positions.reduce((a, p) => a + p.unrealisedPnl, 0) >= 0 ? 'pos' : 'neg'}>
                {fmt(info.positions.reduce((a, p) => a + p.unrealisedPnl, 0))} $
              </b></div>
            </div>
          </section>

          {reusableCoins.length > 0 && (
            <section className="detail">
              <h3>Монеты (топ по USD)</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Монета</th><th>Баланс</th><th>Equity</th><th>USD</th></tr>
                  </thead>
                  <tbody>
                    {reusableCoins.map((c) => (
                      <tr key={c.coin}>
                        <td className="sym">{c.coin}</td>
                        <td>{fmt(c.walletBalance)}</td>
                        <td>{fmt(c.equity)}</td>
                        <td>{fmtCompact(c.usdValue)} $</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {info.positions.length > 0 && (
            <section className="detail">
              <h3>Позиции</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Символ</th><th>Сторона</th><th>Размер</th><th>Вход</th><th>Марка</th><th>Плечо</th><th>LIQ</th><th>TP</th><th>SL</th><th>P&L</th></tr>
                  </thead>
                  <tbody>
                    {info.positions.map((p) => (
                      <tr key={`${p.symbol}-${p.positionIdx}`}>
                        <td className="sym">{p.symbol}</td>
                        <td className={p.side === 'Buy' ? 'pos' : 'neg'}>{p.side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'}</td>
                        <td>{p.size}</td>
                        <td>{fmt(p.avgPrice, p.avgPrice < 1 ? 5 : 4)}</td>
                        <td>{fmt(p.markPrice, p.markPrice < 1 ? 5 : 4)}</td>
                        <td>×{p.leverage}</td>
                        <td>{p.liqPrice == null ? '—' : fmt(p.liqPrice, p.liqPrice < 1 ? 5 : 4)}</td>
                        <td>{p.takeProfit == null ? '—' : fmt(p.takeProfit, p.takeProfit < 1 ? 5 : 4)}</td>
                        <td>{p.stopLoss == null ? '—' : fmt(p.stopLoss, p.stopLoss < 1 ? 5 : 4)}</td>
                        <td className={p.unrealisedPnl >= 0 ? 'pos' : 'neg'}>{fmt(p.unrealisedPnl)} $</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <footer className="foot">
        <Term t="paperTrading" label="Как это работает" />: приватные запросы подписываются HMAC-SHA256 прямо в браузере,
        сервер не нужен. Для следующего шага (реальные ордера) используются те же подписи: лимитный вход, TP/SL,
        reduceOnly-закрытия и amend стопа к безубытку — всё поддерживается API Bybit V5.
      </footer>
    </div>
  );
}