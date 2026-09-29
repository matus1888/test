import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOpts {
  title: string;
  text?: string;
  /** Подпись кнопки подтверждения. */
  ok?: string;
  cancel?: string;
  /** Красная кнопка — для необратимых и денежных действий. */
  danger?: boolean;
}

/**
 * Подтверждение действия внутри приложения вместо `window.confirm`.
 *
 * Почему не нативный диалог: в Chrome на этом проекте обработчик клика после
 * нативного confirm не продолжает работу — accept проходит, а действие не
 * выполняется (из-за этого не удалялась запись крестиком, а «Закрыть все»
 * пришлось отключить). Плюс нативный диалог не переводится и выглядит
 * чужеродно. Здесь то же самое, но в интерфейсе приложения: Esc и клик по
 * фону отменяют, фокус на кнопке подтверждения.
 *
 * Использование:
 * ```tsx
 * const [confirm, confirmDialog] = useConfirm();
 * if (await confirm({ title: 'Удалить запись?' })) remove(id);
 * return <div>…{confirmDialog}</div>;
 * ```
 */
export function useConfirm(): [(opts: ConfirmOpts) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  // Резолвер держим в ref: промис нельзя хранить в состоянии без лишних обёрток,
  // а состояние нужно только для отрисовки панели.
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpts(null);
    resolve?.(value);
  }, []);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    // Новый запрос перекрывает незакрытый предыдущий — иначе тот висел бы вечно.
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(o);
  }), []);

  // Esc отменяет, как и клик по фону.
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, settle]);

  // Компонент размонтировали с открытым диалогом — отменяем, чтобы вызывающий
  // код не видел вечно висящий промис.
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);

  const dialog = opts ? (
    <div className="wt-backdrop" onClick={() => settle(false)}>
      <div
        className="wt-panel cf-panel"
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wt-head">
          <h3>{opts.title}</h3>
        </div>
        {opts.text && <p className="wt-text cf-text">{opts.text}</p>}
        <div className="wt-actions cf-actions">
          <button className="btn" onClick={() => settle(false)}>{opts.cancel ?? 'Отмена'}</button>
          <button
            className={`btn ${opts.danger ? 'btn-danger' : 'btn-ok'}`}
            onClick={() => settle(true)}
            autoFocus
          >{opts.ok ?? 'Подтвердить'}</button>
        </div>
      </div>
    </div>
  ) : null;

  return [confirm, dialog];
}
