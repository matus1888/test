import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CREDENTIALS_EVENT,
  fetchActiveOrders,
  fetchExecutions,
  fetchPositions,
  fetchWalletBalance,
  loadCredentials,
  type ActiveOrder,
  type ApiCredentials,
  type ApiExecution,
  type ApiPosition,
  type WalletBalance,
} from '../api/privateApi';
import { privateWs } from '../api/ws';
import {
  applyUplDelta,
  mergeOrders,
  mergePositions,
  mergeWallet,
  parseWsExecution,
  parseWsOrder,
  parseWsPosition,
  pushFill,
  type ApiFill,
} from '../lib/accountStream';
import {
  loadRealHistory,
  mergeExecutions,
  saveRealHistory,
} from '../lib/realHistory';

/** Снимок реального счёта: кошелёк, позиции и висящие ордера одним запросом. */
export interface ApiAccount {
  wallet: WalletBalance;
  positions: ApiPosition[];
  orders: ActiveOrder[];
  /** Последние исполнения из приватного сокета (пусто, пока сокет не присылал события). */
  fills: ApiFill[];
  at: number;
  /** Снимок обновлён событием сокета, а не REST-опросом. */
  live: boolean;
}

export type ApiState = 'none' | 'checking' | 'on' | 'error';
/** Состояние приватного сокета: 'off' — ключей нет, 'live' — события идут. */
export type WsState = 'off' | 'connecting' | 'live' | 'down';

export interface ApiAccountView {
  cred: ApiCredentials | null;
  state: ApiState;
  error: string | null;
  account: ApiAccount | null;
  /** Обновление снимка (после торговых действий). */
  reload: () => void;
  isFetching: boolean;
  testnet: boolean;
  /** Приватный WebSocket: реальное время по позициям, ордерам и исполнениям. */
  ws: WsState;
}

const ACCOUNT_KEY = 'api-account';

/**
 * Реальные данные счёта Bybit. Ключи берутся из localStorage, а при локальной работе —
 * из `.env` (dev-сервер). Пока ключей нет или запрос не прошёл (retCode != 0) — `state`
 * не `on`, и страницы продолжают показывать бумажный портфель.
 *
 * REST-опрос теперь только страховка и источник снимка. Когда приватный сокет подключён,
 * позиции, ордера, исполнения и баланс приходят событиями (`position`, `order`,
 * `execution`, `wallet`) — интерфейс живой, а REST-спрашивается редко и после реконнекта
 * (пока идёт auth, события могли потеряться).
 */
export function useApiAccount(): ApiAccountView {
  // Ключи: из localStorage, а при локальной работе — из `.env` (dev-сервер).
  // Смена ключей (форма /api, «Удалить ключи») подхватывается по событию.
  const [cred, setCred] = useState<ApiCredentials | null>(() => loadCredentials());
  useEffect(() => {
    const onChange = () => setCred(loadCredentials());
    window.addEventListener(CREDENTIALS_EVENT, onChange);
    return () => window.removeEventListener(CREDENTIALS_EVENT, onChange);
  }, []);

  const qc = useQueryClient();
  const queryKey = [ACCOUNT_KEY, cred?.key ?? null, cred?.testnet ?? null] as const;

  // Состояние сокета нужно и в ref (для refetchInterval), и в state (для интерфейса).
  const wsRef = useRef<WsState>('off');
  const [ws, setWsState] = useState<WsState>('off');
  const setWs = useCallback((s: WsState) => {
    wsRef.current = s;
    setWsState(s);
  }, []);

  const q = useQuery({
    queryKey,
    queryFn: async (): Promise<ApiAccount> => {
      const [wallet, positions, orders, executions] = await Promise.all([
        fetchWalletBalance(cred!),
        fetchPositions(cred!),
        fetchActiveOrders(cred!),
        fetchExecutions(cred!, 'linear', 50),
      ]);
      // REST-исполнения → localStorage-история реальных сделок (дедуп по execId).
      // Живая лента /live хранит их в памяти вкладки; здесь — персистентная страховка.
      addExecutionsToHistory(executions);
      return { wallet, positions, orders, fills: [], at: Date.now(), live: false };
    },
    enabled: cred != null,
    staleTime: 15_000,
    // Живой сокет сам приносит изменения: REST-опрос нужен только для сверки и страховки.
    refetchInterval: () => (wsRef.current === 'live' ? 60_000 : wsRef.current === 'down' ? 15_000 : 30_000),
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    if (!cred || q.error) {
      setWs('off');
      return;
    }
    const conn = privateWs(cred);
    let openedOnce = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    const stopStatus = conn.onStatus((status) => {
      if (status === 'open') {
        // Первое открытие — снимок только что сходил с REST, сверить нечего.
        // Повторное: между обрывами события терялись, нужен свежий REST-снимок.
        if (openedOnce) void qc.refetchQueries({ queryKey });
        openedOnce = true;
        // Данных на пустом счёте может не быть вообще: «live» обозначает готовность
        // потока, а не то, что событие уже пришло.
        setWs('connecting');
        readyTimer = setTimeout(() => {
          if (conn.isReady) setWs('live');
        }, 400);
      } else if (status === 'connecting' || status === 'closed') {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        setWs('down');
      } else if (status === 'idle') {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        setWs('off');
      }
    });

    const patch = (fn: (prev: ApiAccount) => ApiAccount) => {
      qc.setQueryData(queryKey, (prev: ApiAccount | undefined) => (prev ? fn(prev) : prev));
    };

    const off = [
      conn.subscribe('position', (data) => {
        const rows = rowsOf(data, parseWsPosition);
        if (rows.length === 0) return;
        patch((prev) => {
          const { positions, uplDelta } = mergePositions(prev.positions, rows);
          return {
            ...prev,
            positions,
            wallet: applyUplDelta(prev.wallet, uplDelta),
            at: Date.now(),
            live: true,
          };
        });
        setWs('live');
      }),
      conn.subscribe('order', (data) => {
        const rows = rowsOf(data, parseWsOrder);
        if (rows.length === 0) return;
        patch((prev) => ({ ...prev, orders: mergeOrders(prev.orders, rows), at: Date.now(), live: true }));
        setWs('live');
      }),
      conn.subscribe('execution', (data) => {
        const rows = rowsOf(data, parseWsExecution);
        if (rows.length === 0) return;
        patch((prev) => {
          let fills = prev.fills ?? [];
          for (const f of rows) fills = pushFill(fills, f);
          return { ...prev, fills, at: Date.now(), live: true };
        });
        setWs('live');
      }),
      conn.subscribe('wallet', (data) => {
        patch((prev) => ({ ...prev, wallet: mergeWallet(prev.wallet, data), at: Date.now(), live: true }));
        setWs('live');
      }),
    ];

    if (conn.isReady) setWs('live');

    return () => {
      if (readyTimer) clearTimeout(readyTimer);
      stopStatus();
      for (const f of off) f();
    };
    // queryKey — массив, но его элементы примитивны: зависимость стабильна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cred, q.error, qc, setWs, queryKey[1], queryKey[2]]);

  const state: ApiState = !cred
    ? 'none'
    : q.data
      ? 'on'
      : q.error
        ? 'error'
        : 'checking';

  return {
    cred,
    state,
    error: q.error ? ((q.error as Error).message ?? String(q.error)) : null,
    account: q.data ?? null,
    reload: () => {
      void q.refetch();
    },
    isFetching: q.isFetching,
    testnet: !!cred?.testnet,
    ws,
  };
}

/** Приватные темы присылают массив строк (реже — один объект). */
function rowsOf<T>(data: unknown, parse: (row: unknown) => T | null): T[] {
  const list = Array.isArray(data) ? data : [data];
  const out: T[] = [];
  for (const row of list) {
    const parsed = parse(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Персистентная история реальных сделок: REST-исполнения → localStorage (дедуп по execId). */
function addExecutionsToHistory(executions: ApiExecution[]): void {
  if (executions.length === 0) return;
  try {
    const merged = mergeExecutions(loadRealHistory(), executions);
    const prev = loadRealHistory();
    const same = merged.length === prev.length && merged.every((t, i) => t.execId === prev[i]?.execId);
    if (!same) {
      saveRealHistory(merged);
      // Оповещаем страницы/хук — история обновилась.
      import('../lib/realHistory').then((m) => m.emitRealHistoryChanged());
    }
  } catch { /* localStorage недоступен — пропускаем, лента в памяти остаётся */ }
}
