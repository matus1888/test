// Единые часы приложения: системное время, выровненное по времени биржи Bybit.
//
// Зачем это отдельный модуль, а не пара функций в api/privateApi:
// Bybit подписывает КАЖДЫЙ приватный запрос меткой времени часов устройства
// (`X-BAPI-TIMESTAMP`) и принимает её только в окне recvWindow (5 с). Если часы
// телефона сбиты — ручная установка даты, выключенная автосинхронизация, дрейф
// после восстановления из резервной копии, — биржа отвечает
// `10002 Request timestamp outside of receive timestamp range` на любой
// подписанный запрос: и на проверку баланса, и на вход, и на РЫНОЧНОЕ ЗАКРЫТИЕ.
// Ключ при этом абсолютно верный, поэтому по тексту ошибки кажется, что сломан
// ключ, а на самом деле сломаны часы.
//
// То же касается не только подписи: внутри приложения отметки времени сравниваются
// с серверными данными (свечи, исполнения, границы суток). Со сбитыми часами
// расходится и бумажный движок (момент исполнения лимита), и «P&L за сегодня»,
// и цикл обновления свечей. Поэтому источник времени тут один — на весь проект.
//
// Модуль без React и без зависимостей: им пользуются и приватный API (подпись),
// и бумажный движок, и статистика.

/** Как долго доверяем последней синхронизации. */
export const CLOCK_SYNC_TTL_MS = 30 * 60_000;

/**
 * Событие «часы выровнены». Модуль остаётся без React, но интерфейс должен увидеть
 * результат сверки, а не снимок на момент монтирования: синхронизация может
 * завершиться позже (или её вызвать первый приватный запрос).
 */
export const CLOCK_EVENT = 'bybit:clock';

export interface ClockInfo {
  /** Смещение часов устройства относительно биржи, мс (0 — часы совпадают). */
  offsetMs: number;
  /** Момент последней успешной синхронизации, мс системного времени (0 — нет). */
  syncedAt: number;
  /** Действительно ли время сейчас выровнено (не истёк ли TTL). */
  synced: boolean;
}

/** Смещение часов устройства относительно биржи, мс. */
let offsetMs = 0;
/** Момент последней успешной синхронизации (системное время устройства). */
let syncedAt = 0;
/** Последний измеренный круговой задержкой времени биржи, мс. */
let rttMs = 0;
/** Идущая сейчас синхронизация: параллельные запросы не долбят биржу. */
let inFlight: Promise<void> | null = null;

/** Часы, которыми подписываем запросы и датируем рыночные события. */
export function nowBybitMs(): number {
  return Date.now() + offsetMs;
}

/**
 * Время для подписи запроса — намеренно чуть ПОЗАДИ времени биржи.
 * Биржа принимает подпись только в окне recvWindow, а запрос ещё летит в сеть: на
 * мобильном интернете (особенно за VPN/прокси) это 1–3 с в одну сторону, и метка,
 * взятая ровно в момент подписи, к моменту обработки успевает выехать за окно.
 * Живая ошибка на телефоне: `req_timestamp[...872], server_timestamp[...057]`
 * (расхождение 1.8 с) — и 10002 при recv_window 5000. Поэтому отступаем на половину
 * измеренного RTT + 250 мс: подпись «постарее» — безопасная сторона, отстать можно
 * сильнее, чем опереть. Догонять время не нужно: окно двустороннее.
 */
export function nowBybitSafeMs(): number {
  const margin = Math.min(3000, Math.ceil(rttMs / 2) + 250);
  return Date.now() + offsetMs - margin;
}

/** Смещение часов устройства относительно биржи, мс. */
export function clockOffsetMs(): number {
  return offsetMs;
}

export function isClockSynced(): boolean {
  return syncedAt > 0 && Date.now() - syncedAt < CLOCK_SYNC_TTL_MS;
}

/** Состояние часов для интерфейса (страница /api показывает это пользователю). */
export function clockInfo(): ClockInfo {
  return { offsetMs, syncedAt, synced: isClockSynced() };
}

/**
 * Запомнить серверное время биржи. `sentAt`/`gotAt` — локальные отметки до и
 * после запроса: смещение считаем от середины, иначе сетевой лаг уходит в подпись.
 * Возвращает записанное смещение — удобно для тестов.
 */
export function applyServerTime(serverMs: number, sentAt = Date.now(), gotAt = Date.now()): number {
  const mid = Math.round((sentAt + gotAt) / 2);
  const off = serverMs - mid;
  // Метка биржи, отличающаяся от системной на десятки лет, — не «сбитые часы
  // телефона», а неверно прочитанный формат ответа. Молча принимать её нельзя:
  // подпись уехала бы в 2083 год, и приватные запросы падали бы с 10002 без
  // внятного объяснения. Возвращаем прошлое смещение и ждём следующий источник.
  if (Math.abs(off) > MAX_PLAUSIBLE_OFFSET_MS) return offsetMs;
  offsetMs = Number.isFinite(off) ? off : 0;
  syncedAt = gotAt;
  // Задержка нужна для отступа при подписи: чем дольше летит запрос, тем больше отступ.
  if (Number.isFinite(gotAt - sentAt)) rttMs = Math.max(0, gotAt - sentAt);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLOCK_EVENT));
  return offsetMs;
}

/** Сброс синхронизации (тесты). */
export function resetClockSync(): void {
  offsetMs = 0;
  syncedAt = 0;
  rttMs = 0;
  inFlight = null;
}

/**
 * Подхватить время биржи из поля `time` любого публичного ответа V5.
 *
 * Зачем при `/v5/public/time`: этот эндпоинт закрывается прокси, VPN и частью
 * мобильных сетей (наблюдался 404), и тогда часы молча остаются системными — то
 * есть страховка от 10002 не работает. Поле `time` есть в каждом публичном ответе
 * (тикеры, свечи), поэтому часы выравниваются по данным, которые мы всё равно
 * получили, без лишнего запроса.
 *
 * Событие `CLOCK_EVENT` не шлём на каждый ответ (иначе интерфейс перерисовывался бы
 * раз в ответ): обновляем смещение, только если часы ещё не выровнены или оно
 * поехало больше чем на секунду.
 */
export function harvestServerTime(serverTime: unknown, sentAt = Date.now(), gotAt = Date.now()): void {
  const serverMs = Number(serverTime);
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  if (isClockSynced() && Math.abs(serverMs - (gotAt + offsetMs)) < 1000) return;
  applyServerTime(serverMs, sentAt, gotAt);
}

/**
 * Выровнять часы о сервер биржи (без ключа и подписи).
 * Силой не бросает: без сети к публичным эндпоинтам остаётся системное время
 * (иначе не ушёл бы вообще ни один приватный запрос). `force` — пересинхронизировать,
 * даже если TTL не истёк: после 10002 это единственный способ починить подпись.
 *
 * Эндпоинтов два, и это не перестраховка, а закрытие живой дыры: `/v5/public/time`
 * отдаёт 404 части сетей и прокси (проверено), а `/v5/market/time` у той же биржи
 * отвечает 200 и несёт то же время. Плюс смещение подхватывается из поля `time`
 * любого публичного ответа (см. `harvestServerTime`), поэтому после первого же тикера
 * или свечи часы уже выровнены, даже если оба эндпоинта закрыты.
 */
const TIME_PATHS = ['/v5/public/time', '/v5/market/time'] as const;

export async function syncClockFrom(baseUrl: string, force = false): Promise<number> {
  if (!force && isClockSynced()) return offsetMs;
  if (!inFlight) {
    inFlight = (async () => {
      let lastError: unknown = null;
      for (const path of TIME_PATHS) {
        try {
          const sentAt = Date.now();
          const response = await fetch(`${baseUrl}${path}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const j = JSON.parse(await response.text()) as {
            retCode: number;
            retMsg: string;
            result?: { timeSecond?: string; timeNano?: string };
            time?: string;
          };
          if (j.retCode !== 0) throw new Error(`${j.retMsg} (retCode ${j.retCode})`);
          const serverMs = serverTimeMs(j);
          if (!serverMs) throw new Error('биржа не вернула время');
          applyServerTime(serverMs, sentAt, Date.now());
          return;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError ?? new Error('время биржи недоступно');
    })().finally(() => {
      inFlight = null;
    });
  }
  try {
    await inFlight;
  } catch {
    /* публичные эндпоинты недоступны — работаем на часах устройства и на time из ответов */
  }
  return offsetMs;
}

/** Время биржи из ответа: `result.timeSecond/timeNano` (time-эндпоинты) или `time` (все прочие). */
function serverTimeMs(j: { result?: { timeSecond?: string; timeNano?: string }; time?: string }): number | null {
  const sec = Number(j.result?.timeSecond);
  const nano = Number(j.result?.timeNano);
  const hasNano = Number.isFinite(nano) && nano > 0;
  // `timeNano` у Bybit — наносекунды ЭПОХИ (19 цифр, ~1.79e18), а не наносы внутри
  // секунды: деление на 1e6 уже даёт полную эпоху в мс. Раньше к этому прибавляли
  // ещё `timeSecond * 1000`, и смещение часов уезжало на 1.79e12 мс вперёд (2083 год)
  // — подпись не проходила никогда, биржа отвечала 10002, а describeClock писал
  // «синхронизировано, расхождения нет», потому что печатал округлённую дельту.
  // Поэтому длинное число (>1e14, 15+ цифр) трактуем как эпоху и берём его одного.
  if (hasNano && nano > 1e14) return Math.floor(nano / 1e6);
  if (Number.isFinite(sec) && sec > 0) {
    return sec * 1000 + Math.floor((hasNano ? nano : 0) / 1e6);
  }
  const plain = Number(j.time);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

/**
 * Правдоподобие серверной метки: часы устройства могут врать на минуты и даже на годы
 * (телефон со сброшенной датой), но разница в десятки лет — это ошибка разбора формата,
 * а не часы. Такой ответ игнорируем: иначе один неверно прочитанный `timeNano`
 * ломает подпись всех приватных запросов, и приложение об этом даже не сообщает.
 */
const MAX_PLAUSIBLE_OFFSET_MS = 10 * 365 * 24 * 3600_000;

/** Человеческое описание расхождения часов для интерфейса. */
export function describeClock(info: ClockInfo = clockInfo()): string {
  if (!info.synced) return 'не проверялось';
  // Смещение в десятки лет — не часы устройства, а непрочитанный ответ биржи.
  // Такое значение applyServerTime уже отбросил, но если оно всё же дошло до
  // интерфейса (например, из сохранённого состояния), говорим правду, а не
  // «расхождения нет»: иначе диагноз уводит в настройки даты телефона.
  if (Math.abs(info.offsetMs) > MAX_PLAUSIBLE_OFFSET_MS) {
    return 'время биржи прочитано неверно (часы устройства не при чём)';
  }
  const sec = Math.round(info.offsetMs / 1000);
  if (sec === 0) return 'синхронизировано, расхождения нет';
  if (Math.abs(sec) < 60) return `синхронизировано, часы устройства ${sec > 0 ? 'опережают' : 'отстают'} на ${Math.abs(sec)} с`;
  const min = Math.round(sec / 60);
  return `синхронизировано, часы устройства ${sec > 0 ? 'опережают' : 'отстают'} на ${Math.abs(min)} мин`;
}
