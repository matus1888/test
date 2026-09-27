import { Link } from 'react-router-dom';
import { useApiAccount } from '../hooks/useApiAccount';
import RealAccountView from '../components/RealAccountView';

/** Портфель реального счёта: капитал, маржа, позиции и активные ордера из API Bybit. */
export default function RealPortfolioPage() {
  const api = useApiAccount();

  return (
    <div className="page">
      <Link to="/" className="back">← Назад к скринеру</Link>
      <header className="top">
        <div>
          <h1>Портфель Bybit</h1>
          <p className="sub">
            Реальный счёт по API: капитал, занятая маржа, позиции и висящие ордера
            {api.testnet ? ' · тестнет' : ' · мейннет'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="seg">
            <Link to="/real" className="seg-active">Реальный счёт</Link>
            <Link to="/paper">Бумажный</Link>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={api.reload}
            disabled={api.isFetching || api.state === 'none'}
          >
            {api.isFetching ? 'Обновляю…' : 'Обновить'}
          </button>
        </div>
      </header>

      {api.state === 'none' ? (
        <p className="state">
          Ключи не подключены. Задай их на странице <Link to="/api">«API»</Link> — при локальной работе
          достаточно положить <code>API_KEY</code> и <code>API_SECRET</code> в <code>.env</code>.
          Бумажный портфель доступен на <Link to="/paper">отдельной странице</Link>.
        </p>
      ) : (
        <RealAccountView api={api} />
      )}
    </div>
  );
}
