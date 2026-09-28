// Реальный торговый движок поверх API Bybit V5 (LMV: тестнет/мейннет из кредов).
// Цель — повторить бумажную стратегию реальными ордерами: плечо → лимитный вход со
// стопом → лесенка TP1 70% / TP2 20% / runner 10% (reduce-only лимитки) → стоп в безубыток.
// ВАЖНО: работает, пока вкладка открыта; ключи должны быть «без вывода» для мейннета.

import type { Category } from './bybit';
import type { TradePlan } from '../lib/tradePlan';
import {
  cancelAll,
  cancelOrder,
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
  /** Минимальный номинал одного ордера в $ (0 = биржа не ограничивает). */
  minNotional: number;
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
    // По документации Bybit minNotionalValue для linear/inverse «default is 5»:
    // когда биржа отдаёт 0/пусто, действует дефолт 5 $. Иначе раннер (10% позиции)
    // упадёт на бирже с 110003 и лесенка не создастся.
    minNotional: Number(lotSizeFilter.minNotionalValue)
      || (category === 'linear' || category === 'inverse' ? DEFAULT_MIN_NOTIONAL : 0),
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

/** Округление вверх до шага (нужно, чтобы набрать минимальный размер). */
function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !(step > 0)) return value;
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(12));
}

/** Доли лесенки: TP1 70% / TP2 20% / раннер 10% (стратегия не меняется). */
export const LADDER_SHARES = [0.7, 0.2, 0.1] as const;

/** Bybit: minNotionalValue для linear/inverse по умолчанию 5 $, даже если API вернул 0. */
const DEFAULT_MIN_NOTIONAL = 5;

const usd = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

/** Проходит ли одна заявка по ограничениям биржи: шаг количества, minOrderQty, minNotional. */
function orderAllowed(qty: number, price: number, info: InstrumentInfo): boolean {
  if (!(qty > 0)) return false;
  if (info.minOrderQty > 0 && qty < info.minOrderQty - 1e-12) return false;
  if (info.minNotional > 0 && qty * price < info.minNotional - 1e-9) return false;
  return true;
}

export interface LadderSlice {
  frac: number;
  qty: number;
  notional: number;
  ok: boolean;
}

export interface LadderPlan {
  /** Количество позиции по риску, округлённое вниз до шага. */
  qty: number;
  notional: number;
  /** Срезы TP1/TP2/TP3 после округления вниз (как уйдёт на биржу). */
  slices: LadderSlice[];
  /** Минимальное количество, при котором вход и все срезы проходят биржу. */
  minQty: number;
  /** minQty × цена входа, $ — минимальный номинал позиции для этой лесенки. */
  minNotional: number;
  /** Минимальный риск в $ для такой позиции (minQty × дистанция до стопа). */
  minRisk: number;
  /** Нарушения ограничений; пустой список — можно отправлять ордера. */
  problems: string[];
}

/**
 * Считает размер позиции по риску и проверяет, что вход и все три TP пройдут
 * ограничения биржи. Ничего не отправляет — чистый расчёт для пред-полётной проверки.
 */
export function planLadder(
  info: InstrumentInfo,
  entryPrice: number,
  riskMoney: number,
  riskDist: number,
): LadderPlan {
  const step = info.qtyStep > 0 ? info.qtyStep : 1;
  const px = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 0;
  const qty = px > 0 && riskDist > 0 ? roundDownToStep(riskMoney / riskDist, step) : 0;
  const notional = qty * px;

  const slices: LadderSlice[] = LADDER_SHARES.map((frac) => {
    const q = roundDownToStep(qty * frac, step);
    return { frac, qty: q, notional: q * px, ok: orderAllowed(q, px, info) };
  });

  // Минимальная позиция: вход сам по себе + каждый срез лесенки. Срезы округляются
  // вниз до шага, поэтому считаем от биржевого минимума заявки, а не от риска.
  const byNotional = info.minNotional > 0 ? ceilToStep(info.minNotional / px, step) : 0;
  const oneOrderQty = Math.max(info.minOrderQty, byNotional);
  let minQty = oneOrderQty;
  for (const frac of [1, ...LADDER_SHARES]) minQty = Math.max(minQty, oneOrderQty / frac);
  minQty = ceilToStep(minQty, step);
  for (let i = 0; i < 16; i++) {
    const ok = orderAllowed(minQty, px, info)
      && LADDER_SHARES.every((frac) => orderAllowed(roundDownToStep(minQty * frac, step), px, info));
    if (ok) break;
    minQty = ceilToStep(minQty + step, step);
  }

  const problems: string[] = [];
  if (!(px > 0)) problems.push('Нет цены входа.');
  if (!orderAllowed(qty, px, info)) {
    problems.push(`вход ${usd(notional)} $ — меньше минимума биржи (${info.minOrderQty} шт / ${usd(info.minNotional)} $).`);
  }
  slices.forEach((s, i) => {
    if (!s.ok) {
      problems.push(
        `TP${i + 1} (${Math.round(s.frac * 100)}%) — ${usd(s.notional)} $ — меньше минимума биржи `
        + `(${info.minOrderQty} шт / ${usd(info.minNotional)} $).`,
      );
    }
  });

  return { qty, notional, slices, minQty, minNotional: minQty * px, minRisk: minQty * Math.max(riskDist, 0), problems };
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

/** Снять выставленные ордера по id; возвращает количество тех, что снять не удалось. */
async function cancelPlaced(cred: ApiCredentials, category: Category, orders: OrderResult[]): Promise<number> {
  let failed = 0;
  for (const o of orders) {
    if (!o.orderId) continue;
    try {
      await cancelOrder(cred, category, o.orderId);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** Открыть реальную позицию по плану: плечо → лимитный вход со стопом → reduce-only TP1/TP2/TP3. */
export async function openReal(cred: ApiCredentials, args: OpenRealArgs): Promise<OpenRealResult> {
  const { category, symbol, plan, riskMoney, leverage } = args;
  const positionIdx = args.positionIdx ?? 0;
  if (plan.direction !== 'long' && plan.direction !== 'short') throw new Error('План без направления');
  const info = await getInstrument(cred, category, symbol);

  // Пред-полётная проверка ДО изменения плеча и ордеров: размер позиции и каждый срез
  // лесенки должны пройти minOrderQty/minNotional биржи, иначе TP3 отклонится, а позиция
  // останется без выходов. Сообщение объясняет, какой риск нужен.
  const ladder = planLadder(info, plan.entryMid, riskMoney, plan.riskDist);
  if (ladder.problems.length > 0) {
    throw new Error(
      `Размер не проходит ограничения биржи: позиция ${usd(ladder.notional)} $ при риске ${usd(riskMoney)} $. `
      + `Минимум для лесенки 70/20/10 — ${usd(ladder.minNotional)} $ позиции `
      + `(риск от ${usd(ladder.minRisk)} $). `
      + `Причины: ${ladder.problems.join(' ')}`,
    );
  }
  const qty = ladder.qty;

  await setLeverage(cred, { category, symbol, leverage, positionIdx });

  const entryPrice = roundToTick(plan.entryMid, info.tickSize);
  const stopPrice = roundToTick(plan.stop, info.tickSize);
  const entryOrder = await placeOrder(cred, {
    category, symbol, side: plan.direction === 'long' ? 'Buy' : 'Sell', orderType: 'Limit',
    qty: String(qty), price: entryPrice.toFixed(8),
    timeInForce: 'GTC', positionIdx,
    stopLoss: stopPrice.toFixed(8), slTriggerBy: 'MarkPrice',
    orderLinkId: linkId('ent'),
  });

  // Лесенка: reduce-only лимитки на доли позиции (могут стоять до наполнения входа).
  const tpOrders: OrderResult[] = [];
  const placed: OrderResult[] = [entryOrder];
  const tps: Array<[number, number]> = [
    [plan.tp1, LADDER_SHARES[0]],
    [plan.tp2, LADDER_SHARES[1]],
    [plan.tp3, LADDER_SHARES[2]],
  ];
  try {
    for (const [tp, frac] of tps) {
      const tpQty = roundDownToStep(qty * frac, info.qtyStep);
      if (!(tpQty > 0)) continue;
      const tpOrder = await placeOrder(cred, {
        category, symbol, side: plan.direction === 'long' ? 'Sell' : 'Buy', orderType: 'Limit',
        qty: String(tpQty), price: roundToTick(tp, info.tickSize).toFixed(8),
        timeInForce: 'PostOnly', positionIdx, reduceOnly: true,
        orderLinkId: linkId('tp'),
      });
      tpOrders.push(tpOrder);
      placed.push(tpOrder);
    }
  } catch (e) {
    // Откат: снимаем вход и уже выставленные TP, чтобы не остаться с позицией без выходов.
    // Если вход уже наполнился, его стоп (stopLoss в заявке на вход) продолжает работать.
    const failed = await cancelPlaced(cred, category, placed);
    throw new Error(
      `Лесенка не выставилась: ${e instanceof Error ? e.message : String(e)}. `
      + (failed === 0
        ? 'Вход и уже выставленные TP сняты (откат), позиции нет.'
        : `⚠️ Часть ордеров снять не удалось (${failed} шт) — проверь активные ордера на бирже.`),
    );
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

export interface CloseAllResult {
  ok: number;
  failed: { symbol: string; error: string }[];
}

/**
 * Закрыть все переданные позиции по рынку. Закрытие не прерывается первой
 * ошибкой: каждая позиция пытается закрыться, неудачи собираются в `failed`
 * (символ показан, чтобы страница могла назвать конкретного виновника).
 */
export async function closeAllReal(
  cred: ApiCredentials,
  positions: { symbol: string; direction: 'long' | 'short'; positionIdx?: number }[],
  category: Category = 'linear',
): Promise<CloseAllResult> {
  const ok: string[] = [];
  const failed: { symbol: string; error: string }[] = [];
  for (const p of positions) {
    try {
      await closeReal(cred, { category, symbol: p.symbol, direction: p.direction, positionIdx: p.positionIdx });
      ok.push(p.symbol);
    } catch (e) {
      failed.push({ symbol: p.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: ok.length, failed };
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