import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearCredentials,
  CLOCK_EVENT,
  clockInfo,
  credentialFingerprint,
  describeClock,
  devCredentials,
  hasStoredCredentials,
  saveCredentials,
  syncClock,
  type ApiCredentials,
} from '../api/privateApi';
import { useApiAccount } from '../hooks/useApiAccount';
import { useSessionState } from '../hooks/useSessionState';
import { fmt, fmtCompact } from '../lib/format';
import Term from '../components/Term';
import PairLink from '../components/PairLink';

const MAX_COINS = 8;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

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
  // Показать секрет открытым текстом: на телефоне иначе не сверить символы при вставке.
  const [showSecret, setShowSecret] = useState(false);
  // Правка ключа/сети при уже сохранённом ключе: раньше сеть менялась только после
  // удаления ключей, а на телефоне это лишний шаг и повод набрать ключ заново.
  const [editing, setEditing] = useState(false);
  // Отпечаток ключа (12 символов подписи от секрета): позволяет прислать «слепок»
  // ключа для сверки, не показывая сам секрет. Пересчитывается при смене ключей.
  const [fp, setFp] = useState('');
  useEffect(() => {
    if (!api.cred) return;
    let alive = true;
    void credentialFingerprint(api.cred).then((f) => { if (alive) setFp(f.fp); });
    return () => { alive = false; };
  }, [api.cred]);
  // Смещение часов устройства относительно биржи — причина ошибок 10002.
  const [clock, setClock] = useState(() => clockInfo());
  // Сверка часов идёт в фоне (старт приложения, первый приватный запрос, кнопка
  // «Сохранить и проверить»), поэтому перечитываем состояние по событию модуля часов —
  // иначе строка вечно показывала «не проверялось».
  useEffect(() => {
    const onClock = () => setClock(clockInfo());
    window.addEventListener(CLOCK_EVENT, onClock);
    onClock();
    return () => window.removeEventListener(CLOCK_EVENT, onClock);
  }, []);
  // «Не сохранять ключ» — только в память вкладки (сессия). Дефолт из sessionStorage.
  const [sessionOnly, setSessionOnly] = useSessionState<boolean>('api:sessionKeys', false, isBool);

  const cred = api.cred;
  const info = api.account;
  const busy = api.isFetching;
  const error = formError ?? (cred && !info ? api.error : null);
  const fromEnv = dev != null && !hasStoredCredentials();
  const sessionActive = cred && sessionOnly;

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
      saveCredentials({ key: k, secret: s, testnet }, !sessionOnly);
    }
    // Часы телефона могут быть сбиты (10002 на любой приватный запрос) — выравниваем
    // о время биржи ДО проверки подключения, и показываем результат пользователю.
    void syncClock(testnet, true).then(() => setClock(clockInfo()));
    setEditing(false);
    api.reload();
  };

  /** Открыть форму правки с текущими значениями (ключ не удаляется). */
  const startEdit = () => {
    const cur = cred ?? dev;
    setKey(cur?.key ?? '');
    setSecret(cur?.secret ?? '');
    setTestnet(cur?.testnet ?? false);
    setFormError(null);
    setEditing(true);
  };

  const remove = () => {
    clearCredentials();
    setFormError(null);
    setEditing(false);
    setFp('');
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
              {sessionActive
                ? `${cred.testnet ? 'Тестнет' : 'Мейннет'} · сессия вкладки`
                : cred
                  ? fromEnv
                    ? `${cred.testnet ? 'Тестнет' : 'Мейннет'} · из .env${info ? ' · проверен' : ''}`
                    : cred.testnet ? 'Тестнет · настроен' : 'Мейннет · настроен'
                  : 'Не настроен'}
            </b>
          </div>
          {cred && (
            <div className="lvl">
              <span>API-key</span><b className="muted">{cred.key.slice(0, 8)}…{cred.key.slice(-4)}</b>
            </div>
          )}
          {cred && (
            <div className="lvl">
              <span>Отпечаток ключа</span>
              <b className="muted">
                {cred.key.slice(0, 6)}…{cred.key.slice(-4)} · {cred.testnet ? 'тестнет' : 'мейннет'} · секрет {fp || '—'}
                {fp ? (
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      const line = `${cred.key} · ${cred.testnet ? 'тестнет' : 'мейннет'} · секрет ${fp}`;
                      void navigator.clipboard?.writeText(line);
                    }}
                  >
                    Скопировать
                  </button>
                ) : null}
              </b>
            </div>
          )}
          {cred && (
            <div className="lvl">
              <span>Время устройства <Term t="timeSync" /></span>
              <b className={clock.synced ? 'muted' : 'neg'}>{describeClock(clock)}</b>
            </div>
          )}
          {fromEnv && (
            <div className="lvl"><span>Источник</span><b className="muted">.env (локальный dev-сервер) · подключение проверяется автоматически</b></div>
          )}
        </div>
        {!cred || editing ? (
          <div className="card apiform">
            <h3>Ввод ключей</h3>
            <label>API Key
              <input
                name="apiKey"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="text"
                value={key}
                placeholder="Z7... (публичная часть)"
                onChange={(e) => setKey(e.target.value)}
              />
              <span className="muted">символов: {key.length} — сверь с биржей: обрезка при вставке — самая частая причина отказа</span>
            </label>
            <label>API Secret
              {/* type переключается галочкой: на телефоне невозможно сверить символы
                  при вставке, а ошибка в одной букве даёт 10004 «sign error». */}
              <input
                name="apiSecret"
                type={showSecret ? 'text' : 'password'}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="text"
                value={secret}
                placeholder="только подпись, хранится в браузере"
                onChange={(e) => setSecret(e.target.value)}
              />
              <span className="muted">символов: {secret.length} — регистр важен, сверь посимвольно с биржей</span>
            </label>
            <label className="check">
              <input type="checkbox" name="showSecret" checked={showSecret} onChange={(e) => setShowSecret(e.target.checked)} />
              Показать введённый секрет
            </label>
            <label>Сеть
              <select name="apiNet" value={testnet ? 1 : 0} onChange={(e) => setTestnet(e.target.value === '1')}>
                <option value={0}>Мейннет (реальные деньги)</option>
                <option value={1}>Тестнет (api-testnet.bybit.com)</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="sessionOnly"
                checked={sessionOnly}
                onChange={(e) => setSessionOnly(e.target.checked)}
              />
              Не сохранять ключ (только на эту вкладку)<Term t="sessionKeys" />
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
              <button className="btn" onClick={startEdit}>Изменить ключ или сеть</button>
              <button className="btn btn-danger" onClick={remove}>Удалить ключи</button>
            </div>
            {dev && <p className="muted">После удаления ключи из <b>.env</b> подставятся снова — это поведение нужно только локально.</p>}
            <p className="state">
              Ошибка <b>retCode 10002</b> — приложение разбирает её по числам из ответа биржи
              (<b>req_timestamp</b> / <b>server_timestamp</b> / <b>recv_window</b>), поэтому в сообщении
              будет сказано прямо: виновато время или нет. Если метка внутри окна, значит время
              исправно, и причина в ключе: он введён не полностью, с опечаткой, от другого аккаунта
              или от другого стенда (тестнет/мейннет). Часы при этом всё равно сверяются с биржей
              автоматически — на случай сбитого времени телефона.
            </p>
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
                        <td className="sym"><PairLink symbol={p.symbol} category="linear" /></td>
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