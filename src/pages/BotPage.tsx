import { useState } from 'react';
import { Link } from 'react-router-dom';

const BASE = import.meta.env.BASE_URL;

const DOWNLOADS = [
  { name: 'Linux · amd64', file: 'bybitbot-linux-amd64' },
  { name: 'Linux · arm64', file: 'bybitbot-linux-arm64' },
  { name: 'Windows · amd64 (.exe)', file: 'bybitbot-windows-amd64.exe' },
];

interface ConfigFields {
  bot_token: string;
  bybit_key: string;
  bybit_secret: string;
  testnet: boolean;
  risk_per_trade: number;
  leverage: number;
  max_funds_used: number;
  top_n: number;
  interval: string;
  min_confidence: number;
}

/** /bot — инструкция, скачивание бинарника Go-бота и связка с локальным сервером. */
export default function BotPage() {
  const [url, setUrl] = useState('http://127.0.0.1:8787');
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<ConfigFields>({
    bot_token: '',
    bybit_key: '',
    bybit_secret: '',
    testnet: true,
    risk_per_trade: 50,
    leverage: 10,
    max_funds_used: 1000,
    top_n: 8,
    interval: '5',
    min_confidence: 60,
  });

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      const r = await fetch(url + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      setOut(r.ok ? text : `HTTP ${r.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const configPayload = () => ({
    bot_token: cfg.bot_token,
    bybit: { key: cfg.bybit_key, secret: cfg.bybit_secret, testnet: cfg.testnet },
    auto: {
      enabled: true,
      top_n: cfg.top_n,
      interval: cfg.interval,
      risk_per_trade: cfg.risk_per_trade,
      leverage: cfg.leverage,
      min_confidence: cfg.min_confidence,
      max_funds_used: cfg.max_funds_used,
    },
  });

  const downloadTemplate = () => {
    const blob = new Blob([JSON.stringify(configPayload(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bybitbot-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page">
      <Link to="/" className="back">← Назад к скринеру</Link>
      <header className="top">
        <div>
          <h1>Telegram-бот (локальный, Go)</h1>
          <p className="sub">Живёт на твоей машине как отдельный бинарник (win/linux) и работает «в связке» с этим приложением через локальный HTTP. Пока вкладка открыта, браузер отдаёт настройки, бот — торгует и шлёт тебе кнопки.</p>
        </div>
      </header>

      <section className="detail">
        <h3>Шаг 1 — создай бота (и ключи — только для live)</h3>
        <ol className="bot-steps">
          <li>У <b>@BotFather</b> создай бота и скопируй токен вида <code>123456:ABC-xxx</code>.</li>
          <li><b>Режим paper (по умолчанию) ключей не требует</b> — торговля виртуальная, данные берутся из публичных тикеров/свечей. Запусти бота с токеном и работай кнопками: 🎯 Сделка, 📂 Позиции, 📊 Отчёт.</li>
          <li>Для реальной торговли (<code>mode: "live"</code>) понадобится API-ключ Bybit (без права вывода), на тестнете — с <b>testnet.bybit.com</b>.</li>
        </ol>
        </section>

      <section className="detail">
        <h3>Шаг 2 — скачай и запусти</h3>
        <div className="dash-grid">
          {DOWNLOADS.map((d) => (
            <a key={d.file} className="card dash-card" href={`${BASE}bot/${d.file}`} download>
              <b>⬇ {d.name}</b>
              <span className="muted">{d.file}</span>
            </a>
          ))}
        </div>
        <pre className="bot-pre">{`$ ./bybitbot --init            # создаст ~/.bybitbot/config.json
# отредактируй конфиг: bot_token, bybit.key/secret, auto.*
$ ./bybitbot                 # запуск: Telegram-поллинг + локальный API :8787
# в Telegram: /start`}</pre>
      </section>

      <section className="detail">
        <h3>Шаг 3 — связка с браузером (локальный API)</h3>
        <label>Адрес локального бота
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8787" />
        </label>
        <div className="controls">
          <button className="btn" disabled={busy} onClick={() => void call('/health')}>Проверить</button>
          <button className="btn" disabled={busy} onClick={() => void call('/status')}>Статус</button>
          <button className="btn open-long" disabled={busy} onClick={() => void call('/config', configPayload())}>Отправить конфиг</button>
          <button className="btn" disabled={busy} onClick={() => void call('/start')}>▶ Вкл авто</button>
          <button className="btn" disabled={busy} onClick={() => void call('/stop')}>⏸ Выкл авто</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void call('/close-all')}>⛔ Стоп всего</button>
        </div>
        {err && <p className="state err">Не удалось связаться с ботом: {err}<br />Запусти бинарник (сервер на {url}).</p>}
        {out && <pre className="bot-pre">{out}</pre>}
      </section>

      <section className="detail">
        <h3>Шаг 4 — настройки (отправляются в бота и в config.json)</h3>
        <div className="form-grid">
          <label>Bot token <input value={cfg.bot_token} onChange={(e) => setCfg({ ...cfg, bot_token: e.target.value })} placeholder="123456:ABC-..." /></label>
          <label>Bybit key <input value={cfg.bybit_key} onChange={(e) => setCfg({ ...cfg, bybit_key: e.target.value })} /></label>
          <label>Bybit secret <input type="password" value={cfg.bybit_secret} onChange={(e) => setCfg({ ...cfg, bybit_secret: e.target.value })} /></label>
          <label><input type="checkbox" checked={cfg.testnet} onChange={(e) => setCfg({ ...cfg, testnet: e.target.checked })} /> Тестнет</label>
          <label>Риск на сделку, $ <input type="number" value={cfg.risk_per_trade} onChange={(e) => setCfg({ ...cfg, risk_per_trade: Number(e.target.value) })} /></label>
          <label>Плечо <input type="number" value={cfg.leverage} onChange={(e) => setCfg({ ...cfg, leverage: Number(e.target.value) })} /></label>
          <label>Лимит средств (маржа), $ <input type="number" value={cfg.max_funds_used} onChange={(e) => setCfg({ ...cfg, max_funds_used: Number(e.target.value) })} /></label>
          <label>Топ монет <input type="number" value={cfg.top_n} onChange={(e) => setCfg({ ...cfg, top_n: Number(e.target.value) })} /></label>
          <label>Таймфрейм <input value={cfg.interval} onChange={(e) => setCfg({ ...cfg, interval: e.target.value })} /></label>
          <label>Уверенность ≥ % <input type="number" value={cfg.min_confidence} onChange={(e) => setCfg({ ...cfg, min_confidence: Number(e.target.value) })} /></label>
        </div>
        <div className="controls">
          <button className="btn" onClick={downloadTemplate}>Скачать config.json</button>
        </div>
      </section>

      <footer className="foot">
        Лимит средств — максимальная <b>маржа</b> (изолированная) из общего кошелька, которую может занять автоторговля.
        Бот работает, пока запущен процесс; для 24/7 держи бинарник на всегда-включённой машине.
      </footer>
    </div>
  );
}