import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { STEPS, markSeen } from '../lib/guide';

/** Модальный walkthrough по шагам. Сброс к первому шагу — перемонтированием через key у родителя. */
export default function Walkthrough({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { markSeen(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const finish = () => { markSeen(); onClose(); };
  const skip = () => { markSeen(); onClose(); };

  return (
    <div className="wt-backdrop" onClick={skip}>
      <div className="wt-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Обзор приложения">
        <div className="wt-head">
          <h3>Обзор приложения</h3>
          <span className="muted">{i + 1} / {STEPS.length}</span>
        </div>

        <div className="wt-body">
          <b>{step.title}</b>
          <p className="wt-text">{step.text}</p>
          {step.route && (
            <Link className="btn wt-link" to={step.route} onClick={finish}>
              Открыть: {step.route}
            </Link>
          )}
        </div>

        <div className="wt-nav">
          <div className="wt-actions">
            {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Назад</button>}
            <button className="btn" onClick={skip}>Пропустить</button>
          </div>
          <div className="wt-dots">
            {STEPS.map((_, k) => <span key={k} className={`wt-dot ${k === i ? 'active' : ''}`} />)}
          </div>
          <button className="btn open-long" onClick={last ? finish : () => setI(i + 1)}>
            {last ? 'Готово' : 'Далее'}
          </button>
        </div>
      </div>
    </div>
  );
}