import { useState } from 'react';
import { useInstall } from '../hooks/useInstall';
import { InstallIcon } from './icons';

/**
 * Кнопка «Установить приложение». В Chrome/Edge/Linux открывает системный диалог
 * установки, на iOS — короткую инструкцию (там нет beforeinstallprompt).
 * Если приложение уже открыто как отдельная программа, кнопки нет.
 */
export default function InstallButton() {
  const { canInstall, manual, done, install } = useInstall();
  const [hint, setHint] = useState<string | null>(null);
  const [showIos, setShowIos] = useState(false);
  if (done || !canInstall) return null;

  const click = async () => {
    setHint(null);
    if (manual) {
      setShowIos(true);
      return;
    }
    const outcome = await install();
    if (outcome === 'dismissed') setHint('Установку отменили — кнопка осталась на месте.');
    else if (outcome === 'unsupported') setHint('Браузер не предложил установку.');
  };

  return (
    <>
      <button type="button" className="api-link" onClick={() => void click()}>
        <InstallIcon /> Установить
      </button>
      {showIos && (
        <div className="wt-backdrop" onClick={() => setShowIos(false)}>
          <div className="wt-panel" onClick={(e) => e.stopPropagation()}>
            <div className="wt-head">
              <h3>Установка на iPhone</h3>
              <button type="button" className="btn btn-sm" onClick={() => setShowIos(false)}>Закрыть</button>
            </div>
            <p className="wt-text wt-text-tight">
              В Safari системной кнопки установки нет — приложение добавляется вручную:
              «Поделиться» (квадрат со стрелкой вверх) → «На экран Домой» → «Добавить».
              После этого скринер откроется отдельным значком, без адресной строки.
              Данные Bybit всегда требуют сети: котировки и свечи в офлайне не подставляются.
            </p>
          </div>
        </div>
      )}
      {hint && <span className="muted install-hint">{hint}</span>}
    </>
  );
}
