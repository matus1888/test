// WebSocket Bybit V5: одно соединение на (тестнет + категория) для публичных токенов
// и одно на (тестнет + ключ) для приватных. Документация:
// https://bybit-exchange.github.io/docs/v5/ws/connect
//
// Почему сокеты, а не REST-опрос: тикеры идут раз в 100 мс, позиции/ордера/исполнения —
// событиями. Отдельный модуль без React, чтобы его можно было тестировать с заглушкой сокета.

import type { Category } from './bybit';
import { hmacHex, nowBybitSafeMs, syncClock, type ApiCredentials } from './privateApi';

/** Минимальный интерфейс сокета: в тестах подставляется заглушка. */
export interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => WsSocket;

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface WsMessage {
  success?: boolean;
  ret_msg?: string;
  op?: string;
  conn_id?: string;
  topic?: string;
  type?: string;
  ts?: number;
  data?: unknown;
  args?: unknown[];
}

/** Подпись приватного соединения: `GET/realtime{expires}` от секрета ключа. */
export interface WsAuth {
  key: string;
  expires: number;
  signature: string;
}

export type WsTopicHandler = (data: unknown, msg: WsMessage) => void;

export interface WsConnectionOptions {
  url: string;
  /** Подпись приватного соединения; `null` — публичный поток (ключ не нужен). */
  auth?: () => Promise<WsAuth | null>;
  /** Отключение аутентификации приватного потока (тесты). */
  skipAuth?: boolean;
  factory?: WsFactory;
  /** Heartbeat: Bybit просит ping каждые 20 с, иначе соединение рвётся. */
  pingIntervalMs?: number;
  reconnectMs?: { min?: number; max?: number };
  /** Рамка подписки: Bybit не принимает args длиннее 21 000 символов на соединение. */
  argsBudget?: number;
  /** Ограничение на число args в одной рамке (spot — 10 за раз). */
  maxArgsPerFrame?: number;
  /** Разброс задержки переподключения; в тестах выключаем ради детерминизма. */
  jitter?: boolean;
  onStatus?: (status: WsStatus) => void;
}

const OPEN = 1;

export function publicWsUrl(category: Category, testnet: boolean): string {
  const host = testnet ? 'wss://stream-testnet.bybit.com' : 'wss://stream.bybit.com';
  // Для опционов Bybit отдаёт отдельный поток; linear покрывает USDT/USDC перп и фьючерсы.
  const stream = category === 'option' ? 'option' : category === 'spot' ? 'spot' : category === 'inverse' ? 'inverse' : 'linear';
  return `${host}/v5/public/${stream}`;
}

export function privateWsUrl(testnet: boolean): string {
  return testnet ? 'wss://stream-testnet.bybit.com/v5/private' : 'wss://stream.bybit.com/v5/private';
}

/** Подпись для приватного WS: HMAC(secret, `GET/realtime{expires}`), expires = +10 с. */
export async function buildWsAuth(cred: ApiCredentials): Promise<WsAuth> {
  // expires — тоже метка времени: на телефоне со сбитыми часами биржа отклонит
  // рукопожатие. Выравниваемся о время биржи (кэш на 30 мин, здесь почти бесплатно)
  // и берём метку с запасом на сетевой лаг: просрочить подпись страшнее, чем недобрать.
  await syncClock(cred.testnet);
  const expires = nowBybitSafeMs() + 10_000;
  const signature = await hmacHex(cred.secret, `GET/realtime${expires}`);
  return { key: cred.key, expires, signature };
}

/**
 * Соединение с подписками по refcount: несколько компонентов на одну тему создают
 * одну подписку, последний ушедший снимает её. Темы, запрошенные до открытия
 * (или во время переподключения), отправляются автоматически — сокет не должен
 * «помнить», кто его открывал.
 */
export class WsConnection {
  private readonly opts: WsConnectionOptions;
  private socket: WsSocket | null = null;
  private handlers = new Map<string, Set<WsTopicHandler>>();
  /** Темы, которые надо подписать, как только соединение готово к данным. */
  private pending = new Set<string>();
  private statusNow: WsStatus = 'idle';
  private statusListeners = new Set<(status: WsStatus) => void>();
  private ready = false;
  private disposed = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue: string[] = [];

  constructor(opts: WsConnectionOptions) {
    this.opts = opts;
  }

  get status(): WsStatus {
    return this.statusNow;
  }

  /** Готов ли сокет принимать подписки: открыт (и подписан приватный, если нужен ключ). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Подписка на смену состояния соединения (для индикаторов в UI). */
  onStatus(cb: (status: WsStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Сколько подписок на тему (для тестов и диагностики). */
  subscribers(topic: string): number {
    return this.handlers.get(topic)?.size ?? 0;
  }

  get topicCount(): number {
    return this.handlers.size;
  }

  subscribe(topic: string, handler: WsTopicHandler): () => void {
    const first = !this.handlers.has(topic);
    if (first) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler);
    if (first) this.requestTopic(topic);
    return () => this.unsubscribe(topic, handler);
  }

  private requestTopic(topic: string): void {
    if (this.ready) this.sendOp('subscribe', [topic]);
    else this.pending.add(topic);
    this.ensureSocket();
  }

  private unsubscribe(topic: string, handler: WsTopicHandler): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    set.delete(handler);
    if (set.size > 0) return;
    this.handlers.delete(topic);
    this.pending.delete(topic);
    if (this.ready) this.sendOp('unsubscribe', [topic]);
    this.maybeClose();
  }

  /** Никому не нужны данные — закрываем соединение (Bybit не любит частые connect/disconnect). */
  private maybeClose(): void {
    if (this.handlers.size > 0) return;
    this.teardown();
  }

  close(): void {
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.ready = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      try {
        s.close();
      } catch {
        /* сокет уже мёртв — нечего закрывать */
      }
    }
    this.setStatus('idle');
  }

  private setStatus(s: WsStatus): void {
    if (this.statusNow === s) return;
    this.statusNow = s;
    for (const l of this.statusListeners) l(s);
    this.opts.onStatus?.(s);
  }

  private ensureSocket(): void {
    if (this.disposed || this.socket || this.reconnectTimer) return;
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    this.setStatus('connecting');
    const factory = this.opts.factory ?? ((url: string) => new WebSocket(url) as unknown as WsSocket);
    const socket = factory(this.opts.url);
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onclose = () => this.handleClose();
    socket.onerror = () => {
      // Ошибка всегда приводит к onclose — переподключение там.
    };
  }

  private handleOpen(): void {
    this.attempts = 0;
    this.setStatus('open');
    this.startPing();
    if (this.opts.auth && !this.opts.skipAuth) {
      void this.opts.auth().then((auth) => {
        if (!auth) {
          // Без подписи приватные темы не придут — лучше переподключиться, чем молчать.
          this.handleClose();
          return;
        }
        this.socket?.send(JSON.stringify({ op: 'auth', args: [auth.key, auth.expires, auth.signature] }));
      });
      return;
    }
    this.markReady();
  }

  private startPing(): void {
    const every = this.opts.pingIntervalMs ?? 20_000;
    if (every <= 0) return;
    this.pingTimer = setInterval(() => {
      this.raw({ op: 'ping' });
    }, every);
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    // Все текущие темы: запрошенные до открытия и те, что уже были подписаны
    // до обрыва (handlers переживают переподключение).
    const topics = [...new Set([...this.pending, ...this.handlers.keys()])];
    this.pending.clear();
    for (const frame of chunkArgs(topics, this.opts.argsBudget ?? 21_000, this.opts.maxArgsPerFrame ?? Infinity)) {
      this.sendOp('subscribe', frame);
    }
    for (const queued of this.sendQueue.splice(0)) this.send(queued);
  }

  private handleMessage(raw: unknown): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(String(raw)) as WsMessage;
    } catch {
      return; // мусор в кадре — игнорируем, соединение трогать не нужно
    }
    const op = msg.op ?? '';
    // Публичный поток отвечает на ping как {op:'ping', ret_msg:'pong'}, приватный — {op:'pong'}.
    if (op === 'pong' || (op === 'ping' && msg.ret_msg === 'pong')) return;
    if (op === 'auth') {
      if (msg.success === true) this.markReady();
      else this.handleClose(); // неверные ключи: переподключимся с новой подписью, но чаще всего покажем ошибку в UI
      return;
    }
    if (op === 'subscribe' || op === 'unsubscribe') {
      if (msg.success === false) return;
      if (msg.op === 'subscribe' && msg.args) {
        // Сервер подтвердил: тема уже в pending не нужна.
        for (const t of msg.args) if (typeof t === 'string') this.pending.delete(t);
      }
      return;
    }
    const topic = msg.topic;
    if (!topic) return;
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const handler of set) handler(msg.data, msg);
  }

  private handleClose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.disposed) return;
    const wasConnected = this.statusNow !== 'idle';
    this.setStatus(wasConnected ? 'closed' : 'connecting');
    this.ready = false;
    this.socket = null;
    if (this.handlers.size === 0) {
      this.setStatus('idle');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    const { min = 1_000, max = 30_000 } = this.opts.reconnectMs ?? {};
    const base = Math.min(max, min * 2 ** Math.min(this.attempts, 10));
    const delay = this.opts.jitter === false ? base : Math.round(base * (0.7 + 0.6 * Math.random()));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendOp(op: 'subscribe' | 'unsubscribe', args: string[]): void {
    if (args.length === 0) return;
    this.raw({ op, args });
  }

  private raw(payload: unknown): void {
    this.send(JSON.stringify(payload));
  }

  /** Кадр в сокет; если сокета нет — копим и отправим при открытии. */
  private send(payload: string): void {
    const s = this.socket;
    if (s && s.readyState === OPEN) {
      try {
        s.send(payload);
      } catch {
        /* соединение рвётся прямо сейчас — догрузим по reconnect */
      }
      return;
    }
    this.sendQueue.push(payload);
  }
}

/** Режет список тем на кадры: и лимит символов args, и лимит числа args (spot — 10). */
export function chunkArgs(topics: string[], budget: number, maxArgs: number): string[][] {
  const frames: string[][] = [];
  let frame: string[] = [];
  let size = 0;
  for (const t of topics) {
    const add = t.length + 3; // кавычки и запятая
    if (frame.length > 0 && (size + add > budget || frame.length >= maxArgs)) {
      frames.push(frame);
      frame = [];
      size = 0;
    }
    frame.push(t);
    size += add;
  }
  if (frame.length > 0) frames.push(frame);
  return frames;
}

// ── Одно соединение на пару (сеть, категория/ключ) ──────────────────────────

const publicConns = new Map<string, WsConnection>();

/** Публичный поток (tickers/kline) для категории. Соединение общее на всю вкладку. */
export function publicWs(category: Category, testnet = false): WsConnection {
  const id = `${testnet ? 'testnet' : 'mainnet'}:${category}`;
  let conn = publicConns.get(id);
  if (!conn) {
    conn = new WsConnection({ url: publicWsUrl(category, testnet), onStatus: (s) => console.debug(`ws public ${id}: ${s}`) });
    publicConns.set(id, conn);
  }
  return conn;
}

const privateConns = new Map<string, WsConnection>();

/** Приватный поток (position/order/execution/wallet) по ключу. */
export function privateWs(cred: ApiCredentials): WsConnection {
  const id = `${cred.testnet ? 'testnet' : 'mainnet'}:${cred.key}`;
  let conn = privateConns.get(id);
  if (!conn) {
    conn = new WsConnection({
      url: privateWsUrl(cred.testnet),
      auth: () => buildWsAuth(cred),
      onStatus: (s) => console.debug(`ws private ${id}: ${s}`),
    });
    privateConns.set(id, conn);
  }
  return conn;
}

/** Подключены ли сейчас приватные сокеты (для индикатора в UI и для отладки). */
export function privateWsLive(): boolean {
  return [...privateConns.values()].some((c) => c.status === 'open');
}

/** Только для тестов: сбросить singletons между кейсами. */
export function __resetWsSingletons(): void {
  for (const c of publicConns.values()) c.close();
  for (const c of privateConns.values()) c.close();
  publicConns.clear();
  privateConns.clear();
}
