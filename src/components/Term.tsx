import { useCallback, useRef, useState } from 'react';
import { GLOSSARY } from '../lib/glossary';

interface TipPos {
  x: number;
  y: number;
  above: boolean;
}

/**
 * Подпись термина с иконкой-подсказкой. Единственный тултип — кастомный,
 * в fixed-позиции с z-index 9999, поэтому виден поверх скроллящихся таблиц.
 * Нативного title нет, для скринридеров — aria-label.
 */
export default function Term({ t, label }: { t: string; label?: string }) {
  const tip = GLOSSARY[t];
  const icoRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<TipPos | null>(null);

  const show = useCallback(() => {
    const el = icoRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const above = r.top > 190;
    setPos({
      x: Math.min(Math.max(r.left + r.width / 2, 135), window.innerWidth - 135),
      y: above ? r.top : r.bottom,
      above,
    });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  if (!tip) return <>{label}</>;
  return (
    <span className="term">
      {label}
      <span
        ref={icoRef}
        className="t-ico"
        tabIndex={0}
        role="img"
        aria-label={tip}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => e.stopPropagation()}
      >
        i
      </span>
      {pos && (
        <span
          className={`t-tip-fixed ${pos.above ? 'above' : 'below'}`}
          style={{ left: pos.x, top: pos.y }}
          role="tooltip"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
