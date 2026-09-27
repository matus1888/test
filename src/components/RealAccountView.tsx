import { Link } from 'react-router-dom';
import type { ApiAccountView } from '../hooks/useApiAccount';
import { fmt, fmtCompact } from '../lib/format';
import { setupCls } from '../lib/ui';
import Term from './Term';

/** Цена символа: у дорогих монет копейки, у дешёвых — знаки после запятой. */
const pxFmt = (v: number) => (v >= 1000 ? fmt(v, 2) : v >= 1 ? fmt(v, 4) : fmt(v, 6));

const ORD_TYPES: Record<string, string> = {
  Limit: 'Лимит',
  Market: 'Маркет',
  PostOnly: 'PostOnly',
  Stop: 'Стоп',
  StopMarket: 'Стоп-маркет',
  TakeProfit: 'TP',
  TakeProfitMarket: 'TP-маркет',
  TrailingStop: 'Трейлинг-стоп',
};

interface Props {
  api: ApiAccountView;
}

/**
 * Портфель по данным API: кошелёк, позиции и висящие ордера Bybit. Показывается вместо
 * бумажного портфеля, когда ключи подключены и снимок счёта пришёл без ошибки.
 * Торговые действия (закрыть, перенос в безубыток, лесенка) — на /live.
 */
export default function RealAccountView({ api }: Props) {
  if (api.state === 'checking' || api.state === 'none') {
    return (
      <p className="state">
        {api.state === 'checking' ? 'Проверяю подключение к Bybit…' : 'API не подключён — показан бумажный портфель.'}
      </p>
    );
  }
  if (api.state === 'error' || api.account == null) {
    return (
      <p className="state err">
        Не удалось получить данные счёта: {api.error}. Проверь ключ на странице{' '}
        <Link to="/api">«API»</Link> — ниже доступен бумажный портфель.
      </p>
    );
  }

  const { wallet, positions, orders, at } = api.account;
  const upl = wallet.totalPerpUPL;
  const uplCls = upl > 0 ? 'pos' : upl < 0 ? 'neg' : '';
  const realized = wallet.totalWalletBalance > 0 ? wallet.totalEquity - wallet.totalWalletBalance - upl : 0;

  return (
    <>
      <section className="cards">
        <div className="card">
          <h3>Капитал Bybit</h3>
          <div className="lvl"><span>Equity</span><b>{fmt(wallet.totalEquity, 2)} $</b></div>
          <div className="lvl"><span>Баланс кошелька</span><b>{fmt(wallet.totalWalletBalance, 2)} $</b></div>
          <div className="lvl"><span>Доступно</span><b>{fmt(wallet.totalAvailableBalance, 2)} $</b></div>
        </div>
        <div className="card">
          <h3>Маржа</h3>
          <div className="lvl">
            <span><Term t="margin" label="Занято" /></span>
            <b>{fmt(wallet.totalInitialMargin, 2)} $</b>
          </div>
          <div className="lvl"><span>Под позициями</span><b>{fmt(wallet.totalPositionInitialMargin, 2)} $</b></div>
          <div className="lvl"><span>Под ордерами</span><b>{fmt(wallet.totalOrderInitialMargin, 2)} $</b></div>
        </div>
        <div className="card">
          <h3><Term t="pnl" label="P&L" /></h3>
          <div className="lvl">
            <span>Нереализованный (uP&L)</span>
            <b className={uplCls}>{upl >= 0 ? '+' : ''}{fmt(upl, 2)} $</b>
          </div>
          <div className="lvl"><span>Маржинальный баланс</span><b>{fmt(wallet.totalMarginBalance, 2)} $</b></div>
          <div className="lvl">
            <span>Оценка по equity</span>
            <b className={realized > 0 ? 'pos' : realized < 0 ? 'neg' : ''}>
              {realized >= 0 ? '+' : ''}{fmt(realized, 2)} $
            </b>
          </div>
        </div>
        <div className="card">
          <h3><Term t="position" label="Позиции" /></h3>
          <div className="lvl"><span>Открыто</span><b>{positions.length}</b></div>
          <div className="lvl"><span>Висящих ордеров</span><b>{orders.length}</b></div>
          <div className="lvl"><span>Обновлено</span><b className="muted">{new Date(at).toLocaleTimeString('ru-RU')}</b></div>
        </div>
      </section>

      <h2>Позиции Bybit</h2>
      {positions.length === 0 ? (
        <p className="state">Позиций нет. Открыть реальную сделку можно на странице <Link to="/live">«Live»</Link>.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Символ</th>
                <th>Сторона</th>
                <th>Размер</th>
                <th>Вход</th>
                <th>Марк</th>
                <th>Плечо</th>
                <th>Liq</th>
                <th>SL / TP</th>
                <th>uP&L</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={`${p.symbol}-${p.positionIdx}`}>
                  <td className="sym">{p.symbol}</td>
                  <td className={setupCls(p.side === 'Buy' ? 'long' : 'short')}>{p.side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'}</td>
                  <td>{fmt(p.size, 4)}</td>
                  <td>{pxFmt(p.avgPrice)}</td>
                  <td>{pxFmt(p.markPrice)}</td>
                  <td>×{fmt(p.leverage, 0)}</td>
                  <td className="muted">{p.liqPrice && p.liqPrice > 0 ? pxFmt(p.liqPrice) : '—'}</td>
                  <td className="muted">
                    {p.stopLoss ? pxFmt(p.stopLoss) : '—'} / {p.takeProfit ? pxFmt(p.takeProfit) : '—'}
                  </td>
                  <td className={p.unrealisedPnl > 0 ? 'pos' : p.unrealisedPnl < 0 ? 'neg' : ''}>
                    {p.unrealisedPnl >= 0 ? '+' : ''}{fmt(p.unrealisedPnl, 2)} $
                  </td>
                  <td>
                    <Link to="/live" className="btn btn-sm">Управлять</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Активные ордера</h2>
      {orders.length === 0 ? (
        <p className="state">Висящих ордеров нет.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Символ</th>
                <th>Сторона</th>
                <th>Тип</th>
                <th>Размер</th>
                <th>Цена</th>
                <th>SL / TP</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderId}>
                  <td className="sym">{o.symbol}</td>
                  <td className={setupCls(o.side === 'Buy' ? 'long' : 'short')}>{o.side === 'Buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</td>
                  <td>{ORD_TYPES[o.orderType] ?? o.orderType}</td>
                  <td>{fmt(o.qty, 4)}</td>
                  <td>{o.orderType === 'Market' ? 'маркет' : pxFmt(o.price)}</td>
                  <td className="muted">
                    {o.stopLoss ? pxFmt(o.stopLoss) : '—'} / {o.takeProfit ? pxFmt(o.takeProfit) : '—'}
                  </td>
                  <td className="muted">
                    {o.orderStatus}
                    {o.timeInForce ? ` · ${o.timeInForce}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="foot">
        Данные Bybit V5 ({api.testnet ? 'тестнет' : 'мейннет'}), автообновление раз в 30 с и при возврате на вкладку.
        Кнопки «Обновить» и торговые действия — на странице <Link to="/live">«Live»</Link>.
        Занятая маржа ({fmtCompact(wallet.totalInitialMargin)} $) — именно эти деньги депозита заблокированы под сделки;
        торговый номинал позиций в разы больше ({fmtCompact(positions.reduce((a, p) => a + p.size * p.markPrice, 0))} $).
      </footer>
    </>
  );
}
