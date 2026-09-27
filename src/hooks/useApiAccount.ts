import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CREDENTIALS_EVENT,
  fetchActiveOrders,
  fetchPositions,
  fetchWalletBalance,
  loadCredentials,
  type ActiveOrder,
  type ApiCredentials,
  type ApiPosition,
  type WalletBalance,
} from '../api/privateApi';

/** Снимок реального счёта: кошелёк, позиции и висящие ордера одним запросом. */
export interface ApiAccount {
  wallet: WalletBalance;
  positions: ApiPosition[];
  orders: ActiveOrder[];
  at: number;
}

export type ApiState = 'none' | 'checking' | 'on' | 'error';

export interface ApiAccountView {
  cred: ApiCredentials | null;
  state: ApiState;
  error: string | null;
  account: ApiAccount | null;
  /** Обновление снимка (после торговых действий). */
  reload: () => void;
  isFetching: boolean;
  testnet: boolean;
}

/**
 * Реальные данные счёта Bybit. Ключи берутся из localStorage, а при локальной работе —
 * из `.env` (dev-сервер). Пока ключей нет или запрос не прошёл (retCode != 0) — `state`
 * не `on`, и страницы продолжают показывать бумажный портфель.
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

  const q = useQuery({
    queryKey: ['api-account', cred?.key ?? null, cred?.testnet ?? null],
    queryFn: async (): Promise<ApiAccount> => {
      const [wallet, positions, orders] = await Promise.all([
        fetchWalletBalance(cred!),
        fetchPositions(cred!),
        fetchActiveOrders(cred!),
      ]);
      return { wallet, positions, orders, at: Date.now() };
    },
    enabled: cred != null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

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
  };
}
