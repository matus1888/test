import { useCallback, useEffect, useState } from 'react';

/** Событие Chrome/Edge, которым браузер предлагает установить приложение. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Событие может прилететь ДО монтирования React (особенно при быстром переходе
// по прямой ссылке), поэтому слушатель ставим один раз на уровне модуля.
let saved: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Без preventInstallPrompt Chrome не покажет свою полосу установки.
    e.preventDefault();
    saved = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    saved = null;
    emit();
  });
}

/** Приложение уже открыто как отдельная программа (не в вкладке браузера). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return window.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone;
}

/** iOS Safari не умеет beforeinstallprompt — там установка только вручную. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export interface InstallState {
  /** Кнопку установки показывать: браузер предложил установку либо это iOS. */
  canInstall: boolean;
  /** Нужен ручной путь (iOS): показать инструкцию, а не системный диалог. */
  manual: boolean;
  /** Уже установлено / открыто как приложение. */
  done: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unsupported'>;
}

/**
 * Установка приложения на домашний экран. Chrome/Edge/Linux показывают системный
 * диалог, iOS — инструкцию «Поделиться → На экран Домой» (события там нет).
 */
export function useInstall(): InstallState {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const standalone = isStandalone();
  const install = useCallback(async () => {
    if (!saved) return 'unsupported' as const;
    await saved.prompt();
    const choice = await saved.userChoice;
    if (choice.outcome === 'accepted') {
      installed = true;
      saved = null;
      bump((n) => n + 1);
    }
    return choice.outcome;
  }, []);

  return {
    canInstall: !standalone && !installed && (saved != null || isIos()),
    manual: saved == null,
    done: standalone || installed,
    install,
  };
}
