// Реальный торговый движок поверх API Bybit V5 (LMV: тестнет/мейннет из кредов).
// Цель — повторить бумажную стратегию реальными ордерами: плечо → лимитный вход со
// стопом → лесенка TP1 70% / TP2 20% / runner 10% (reduce-only лимитки) → стоп в безубыток.
// ВАЖНО: работает, пока вкладка открыта; ключи должны быть «без вывода» для мейннета.

import type { Category } from './bybit';
import type { TradePlan } from '../lib/tradePlan';
import {
  cancelAll,
  fetchPositions,
  placeOrder,
  requestPrivate,
  setLeverage,
  setPositionTradingStop,
  type ApiCredentials,
  type OrderResult,
} from './privateApi';

export interface InstrumentInfo {
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
}

const instrumentCache = new Map<string, InstrumentInfo>();

export async function getInstrument(cred: ApiCredentials, category: Category, symbol: string): Promise<InstrumentInfo> {
  const key = `${category}:${symbol}`;
  const cached = instrumentCache.get(key);
  if (cached) return cached;
  const res = await requestPrivate<{ list?: Record<string, Record<string, string>>[] }>(
    'GET', '/v5/market/instruments-info', { category, symbol }, cred,
  );
  const it = res.list?.[0] ?? {};
  const priceFilter = it.priceFilter ?? {};
  const lotSizeFilter = it.lotSizeFilter ?? {};
  const info: InstrumentInfo = {
    tickSize: Number(priceFilter.tickSize) || 0.0001,
    qtyStep: Number(lotSizeFilter.qtyStep) || 1,
    minOrderQty: Number(lotSizeFilter.minOrderQty) || 0,
  };
  instrumentCache.set(key, info);
  return info;
}

/** Округление вниз до шага (защита от float-мусора). */
export function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !(step > 0)) return value;
  const r = Math.floor(value / step + 1e-9) * step;
  return Number(r.toPrecision(12));
}

/** Округление к ближайшему тику. */
export function roundToTick(value: number, tick: number): number {
  if (!Number.isFinite(value) || !(tick > 0)) return value;
  const r = Math.round(value / tick) * tick;
  return Number(r.toPrecision(12));
}

export interface OpenRealArgs {
  category: Category;
  symbol: string;
  plan: TradePlan;
  riskMoney: number;
  leverage: number;
  positionIdx?: number;
}

export interface OpenRealResult {
  qty: number;
  notional: number;
  margin: number;
  entryOrder: OrderResult;
  tpOrders: OrderResult[];
}

function linkId(tag: string): string {
  return `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 36);
}

/** Открыть реальную позицию по плану: плечо → лимитный вход со стопом → reduce-only TP1/TP2/TP3. */
export async function openReal(cred: ApiCredentials, args: OpenRealArgs): Promise<OpenRealResult> {
  const { category, symbol, plan, riskMoney, leverage } = args;
  const positionIdx = args.positionIdx ?? 0;
  const info = await getInstrument(cred, category, symbol);
  if (plan.direction !== 'long' && plan.direction !== 'short') throw new Error('План без направления');

  const side: 'Buy' | 'Sell' = plan.direction === 'long' ? 'Buy' : 'Sell';
  const tpSide: 'Buy' | 'Sell' = side === 'Buy' ? 'Sell' : 'Buy';
  const qty = roundDownToStep(riskMoney / plan.riskDist, info.qtyStep);
  if (!(qty > 0)) throw new Error('Размер позиции меньше минимального шага');

  await setLeverage(cred, { category, symbol, leverage, positionIdx });

  const entryPrice = roundToTick(plan.entryMid, info.tickSize);
  const stopPrice = roundToTick(plan.stop, info.tickSize);
  const entryOrder = await placeOrder(cred, {
    category, symbol, side, orderType: 'Limit',
    qty: String(qty), price: entryPrice.toFixed(8),
    timeInForce: 'GTC', positionIdx,
    stopLoss: stopPrice.toFixed(8), slTriggerBy: 'MarkPrice',
    orderLinkId: linkId('ent'),
  });

  // Лесенка: reduce-only лимитки на доли позиции (могут стоять до наполнения входа).
  const tpOrders: OrderResult[] = [];
  const tps: Array<[number, number]> = [
    [plan.tp1, 0.7],
    [plan.tp2, 0.2],
    [plan.tp3, 0.1],
  ];
  for (const [tp, frac] of tps) {
    const tpQty = roundDownToStep(qty * frac, info.qtyStep);
    if (!(tpQty > 0)) continue;
    tpOrders.push(await placeOrder(cred, {
      category, symbol, side: tpSide, orderType: 'Limit',
      qty: String(tpQty), price: roundToTick(tp, info.tickSize).toFixed(8),
      timeInForce: 'PostOnly', positionIdx, reduceOnly: true,
      orderLinkId: linkId('tp'),
    }));
  }

  return {
    qty,
    notional: qty * plan.entryMid,
    margin: (qty * plan.entryMid) / leverage,
    entryOrder,
    tpOrders,
  };
}

/** Закрыть позицию и убрать её ордера: рыночный reduceOnly-закрытие (qty=0+closeOnTrigger). */
export async function closeReal(
  cred: ApiCredentials,
  args: { category: Category; symbol: string; direction: 'long' | 'short'; positionIdx?: number },
): Promise<void> {
  const { category, symbol, direction } = args;
  const positionIdx = args.positionIdx ?? 0;
  await cancelAll(cred, category, symbol);
  await placeOrder(cred, {
    category, symbol,
    side: direction === 'long' ? 'Sell' : 'Buy',
    orderType: 'Market', qty: '0',
    positionIdx, reduceOnly: true, closeOnTrigger: true,
    orderLinkId: linkId('cls'),
  });
}

/** Перенести стоп позиции в безубыток (после TP1). */
export async function moveStopToBreakeven(
  cred: ApiCredentials,
  args: { category: Category; symbol: string; entryPrice: number; positionIdx?: number },
): Promise<void> {
  const tick = (await getInstrument(cred, args.category, args.symbol)).tickSize;
  const be = roundToTick(args.entryPrice, tick).toFixed(8);
  await setPositionTradingStop(cred, {
    category: args.category,
    symbol: args.symbol,
    stopLoss: be,
    slTriggerBy: 'MarkPrice',
    positionIdx: args.positionIdx ?? 0,
  });
}

/** Текущие чистые позиции (linear), уже с парсингом. */
export async function fetchLivePositions(cred: ApiCredentials, category: Category = 'linear') {
  return (await fetchPositions(cred, category)).filter((p) => p.size > 0);
}