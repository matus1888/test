#!/usr/bin/env node
// Walk-forward проверка торговых планов на истории.
//
// Чем отличается от «скрипта ради цифр»:
//   — модель входа честная: лимит в зону засчитывается, только если зона реально задета;
//   — паритет с приложением: те же ворота (минимальная уверенность, отсев тонких/вялых пар);
//   — издержки: тейкер-комиссия, проскальзывание, фандинг (по истории фандинга);
//   — отчёт по четвертям времени — видно, живёт ли эффект или это одна удачная неделя;
//   — фиксированный универсум (scripts/universe.json), чтобы прогоны были сравнимы
//     и мёртвые пары не выпадали из выборки задним числом;
//   — кэш свечей и фандинга на диске, повторный прогон не качает всё заново.
//
// Использование:
//   bun scripts/backtest.mjs                          # универсум из universe.json
//   bun scripts/backtest.mjs --symbols BTCUSDT,ETHUSDT
//   bun scripts/backtest.mjs --interval 15 --ids BTCUSDT
//   bun scripts/backtest.mjs --no-funding --slippage-bps 2
//   bun scripts/backtest.mjs --conf 0               # без порога уверенности
//
// Отчёт: консоль + scripts/backtest-report.json (механический diff между прогонами).

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics } from '../src/lib/metrics.ts';
import { buildTradePlan } from '../src/lib/tradePlan.ts';
import { evaluatePosition, TP_FRACS, TAKER_FEE_RATE } from '../src/lib/paper.ts';
import { SUSPICIOUS } from '../src/lib/pairFilter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ---- CLI ------------------------------------------------------------------
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
const INTERVAL = arg('interval', '5');
const BARS = Number(arg('bars', '8000'));            // глубина истории на символ
const MIN_CONF = Number(arg('conf', '80'));          // паритет с фильтром скринера
const SLIPPAGE_BPS = Number(arg('slippage-bps', '1')); // проскальзывание в базис-пунктах на одну сторону
const RISK_USD = Number(arg('risk', '100'));         // риск на сделку, $ (определяет размер и комиссии)
const USE_FUNDING = !flag('no-funding');
const WINDOW = 200;
const STEP = 5;
const ENTRY_TOUCH_BARS = 3; // в течение скольких баров зона должна быть задета, чтобы вход был

let symbolsCli = arg('symbols');
if (symbolsCli) symbolsCli = symbolsCli.split(',').map((s) => s.trim()).filter(Boolean);

// ---- Сеть и кэш -----------------------------------------------------------
async function jget(url, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(`${j.retMsg} ${url}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cacheFile = (name) => join(CACHE_DIR, name);
async function cachedJson(name, ttlMs, loader) {
  const f = cacheFile(name);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (m.savedAt && Date.now() - m.savedAt < ttlMs) return m.data;
  }
  const data = await loader();
  writeFileSync(f, JSON.stringify({ savedAt: Date.now(), data }));
  return data;
}

async function klines(symbol, target = BARS) {
  return cachedJson(`kline-${INTERVAL}-${symbol}.json`, 30 * 60_000, async () => {
    const out = [];
    let end = undefined;
    while (out.length < target) {
      const q = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${INTERVAL}&limit=1000`
        + (end ? `&end=${end}` : '');
      const k = await jget(q);
      if (!k.list || k.list.length === 0) break;
      const batch = k.list
        .map((r) => ({
          time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
          low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), turnover: Number(r[6]),
        }))
        .filter((c) => Number.isFinite(c.time) && c.close > 0)
        .sort((a, b) => a.time - b.time);
      out.unshift(...batch);
      const oldest = batch[0].time;
      if (k.list.length < 1000) break;
      end = oldest - 1;
      await sleep(120);
    }
    const seen = new Set();
    return out
      .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
      .slice(-target);
  });
}

/** История фандинга за период (8-часовые выплаты). Возвращает [{time, rate}] упорядоченно. */
async function fundingHistory(symbol) {
  if (!USE_FUNDING) return [];
  try {
    return await cachedJson(`funding-${symbol}.json`, 6 * 60 * 60_000, async () => {
      const r = await jget(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1000`);
      const rows = (r.list ?? [])
        .map((x) => ({ time: Number(x.fundingRateTimestamp) || Number(x.createdTime), rate: Number(x.fundingRate) }))
        .filter((x) => Number.isFinite(x.time) && Number.isFinite(x.rate))
        .sort((a, b) => a.time - b.time);
      return rows;
    });
  } catch {
    return [];
  }
}

// ---- Универсум: фиксируем один раз, дальше сравниваем одинаковое --------------
async function loadUniverse() {
  if (symbolsCli) return symbolsCli;
  const f = join(__dirname, 'universe.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const t = await jget('https://api.bybit.com/v5/market/tickers?category=linear');
  const top = t.list
    .filter((x) => Number(x.lastPrice) > 0)
    .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
    .slice(0, Math.min(Number(arg('universe', '40')), 40))
    .map((x) => x.symbol);
  writeFileSync(f, JSON.stringify(top, null, 2));
  console.log(`universe.json записан (${top.length} символов) — зафиксировали выборку для повторяемых прогонов`);
  return top;
}

/** Паритет с отсевом сомнительных пар: тонкие (оборот < порога) и вялые (ATR% < порога). */
async function survivalGate(symbols) {
  if (!USE_FUNDING || symbols.length > 60) return new Map(symbols.map((s) => [s, { ok: true }]));
  try {
    const t = await jget('https://api.bybit.com/v5/market/tickers?category=linear');
    const m = new Map();
    for (const x of t.list) {
      const s = String(x.symbol ?? '');
      if (!symbols.includes(s)) continue;
      const turnover24h = Number(x.turnover24h) || 0;
      m.set(s, { ok: turnover24h >= SUSPICIOUS.minTurnover, turnover24h });
    }
    return m;
  } catch {
    return new Map(symbols.map((s) => [s, { ok: true }]));
  }
}

// ---- Модель исполнения -------------------------------------------------------
const slip = (side, price) => price * (1 + (side === 1 ? 1 : -1) * (SLIPPAGE_BPS / 10_000));

/** Выполнение одной сделки. Бесплатно: 0.555 б.п. от номинала стороны. */
function feeFor(notional) {
  const rate = TAKER_FEE_RATE.linear;
  return Math.abs(notional) * rate;
}

/**
 * Проигрывание сделки по правилам бумажного движка (evaluatePosition), но с
 * настоящими ценами исполнения: лимитный вход в зону (только если зона задета),
 * стоп/тейки со слипом, фандинг за время удержания.
 */
function runTrade(plan, candles, idx, funding) {
  const side = plan.direction === 'long' ? 1 : -1;
  const entryMid = plan.entryMid;
  const riskDist = plan.riskDist || 1e-9;
  const qty = RISK_USD / riskDist;

  // 1) Вход: ждём касания зоны в течение ENTRY_TOUCH_BARS баров.
  let entryIdx = -1;
  for (let k = idx; k < Math.min(idx + ENTRY_TOUCH_BARS, candles.length); k++) {
    const c = candles[k];
    const touched = side === 1 ? c.low <= plan.entryHigh : c.high >= plan.entryLow;
    if (touched) { entryIdx = k; break; }
  }
  if (entryIdx < 0) return null; // лимит не набрался — сделки нет
  const entryTime = candles[entryIdx].time;
  const entryFill = slip(side, entryMid);

  // 2) Дальше — как бумажный движок: события по бару (касания по «сырым» уровням,
  // слип учтём при исполнении ниже — иначе он будет посчитан дважды).
  const draft = {
    id: 'bt', symbol: 'X', category: 'linear', interval: INTERVAL,
    direction: plan.direction,
    entryPrice: entryFill, entryLow: plan.entryLow, entryHigh: plan.entryHigh,
    stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
    leverage: 3, qty, openedAt: entryTime, status: 'open',
    legs: [],
  };
  const ev = evaluatePosition(draft, candles.slice(entryIdx));
  if (ev.events.length === 0 && !ev.stopHit) return null;

  // 3) Фандинг за удержание (только если включён и есть история).
  let fundingCost = 0;
  if (funding.length > 0) {
    const exitTime = ev.events.at(-1)?.time ?? Number.POSITIVE_INFINITY;
    for (const f of funding) {
      if (f.time >= entryTime && f.time < exitTime) {
        // Лонг платит положительный фандинг, шорт получает.
        fundingCost += -side * f.rate * qty * entryMid;
      }
    }
  }

  // 4) Денежный P&L по ногам./остатку, с комиссией на каждое исполнение.
  const legs = ev.events.filter((e) => e.type === 'tp1' || e.type === 'tp2');
  let pnl = 0;
  let remaining = 1;
  for (const leg of legs) {
    const frac = leg.type === 'tp1' ? TP_FRACS.tp1 : TP_FRACS.tp2;
    const px = slip(-side, leg.price);
    const notional = qty * frac * px;
    pnl += side * (px - entryFill) * qty * frac - feeFor(notional);
    remaining -= frac;
  }
  if (remaining > 0 && ev.events.length > 0) {
    const last = ev.events.at(-1);
    if (last.type === 'tp3') {
      const px = slip(-side, last.price);
      pnl += side * (px - entryFill) * qty * remaining - feeFor(qty * remaining * px);
      remaining = 0;
    } else if (last.type === 'stop' || last.type === 'breakeven' || last.type === 'liq') {
      const px = last.type === 'breakeven' ? entryFill : slip(-side, last.price);
      pnl += side * (px - entryFill) * qty * remaining - feeFor(qty * remaining * px);
      remaining = 0;
    }
  }
  if (remaining > 0) {
    // Сделка всё ещё открыта на конце истории — цензурируем: не считаем ни прибыль, ни убыток.
    return { censored: true, how: 'open-flat', r: 0, mfe: ev.mfeR, mae: ev.maeR };
  }
  pnl -= fundingCost;
  return {
    censored: false,
    how: ev.events.at(-1)?.type ?? 'flat',
    r: pnl / RISK_USD,
    mfe: ev.mfeR,
    mae: ev.maeR,
    runtimeMs: (ev.events.at(-1)?.time ?? entryTime) - entryTime,
  };
}

// ---- Основной цикл -----------------------------------------------------------
const universe = await loadUniverse();
console.log('symbols:', universe.join(', '));
const gate = await survivalGate(universe);

const agg = {
  signals: 0, filled: 0, censored: 0, wait: 0,
  byDir: {}, byConf: {}, byAtr: {}, byQ: {}, byMfe: {},
  rSum: 0, n: 0,
};
const bump = (m, k, v) => {
  m[k] ??= { n: 0, sumR: 0, wins: 0 };
  m[k].n += 1; m[k].sumR += v.r; if (v.r > 0) m[k].wins += 1;
};
const confBucket = (c) => (c < 60 ? '<60' : c < 75 ? '60-75' : c < 85 ? '75-85' : c < 92 ? '85-92' : '>=92');
const atrBucket = (p) => (p < 1 ? '<1%' : p < 2 ? '1-2%' : p < 3 ? '2-3%' : '>=3%');

const t0 = Date.now();
for (const s of universe) {
  const g = gate.get(s) ?? { ok: true };
  if (!g.ok) { console.log(`${s}: отсеян по обороту`); continue; }
  let rows;
  try {
    rows = await klines(s);
  } catch (e) {
    console.log(`${s}: ошибка загрузки свечей — пропускаю (${String(e instanceof Error ? e.message : e).slice(0, 80)})`);
    continue;
  }
  const funding = await fundingHistory(s);
  let sig = 0;
  for (let i = WINDOW; i < rows.length - 10; i += STEP) {
    const win = rows.slice(i - WINDOW, i);
    const m = computeMetrics(win);
    if (!m) continue;
    const plan = buildTradePlan(win, m, 'linear', null, INTERVAL);
    if (!plan || plan.direction === 'wait') { agg.wait += 1; continue; }
    if (MIN_CONF > 0 && plan.confidence < MIN_CONF) continue;             // паритет: порог уверенности
    const atrPct = m.atrPct;
    if (atrPct < SUSPICIOUS.minAtrPct) continue;                           // паритет: вялый ход
    agg.signals += 1; sig += 1;
    const res = runTrade(plan, rows, i, funding);
    if (!res) continue; // лимит не набрался
    agg.filled += 1;
    if (res.censored) { agg.censored += 1; continue; }
    agg.n += 1; agg.rSum += res.r;
    // четверть истории по времени
    const tt = rows[i].time;
    const [tMin, tMax] = [rows[0].time, rows.at(-1).time];
    const q = tMax > tMin ? Math.floor((tt - tMin) / ((tMax - tMin) / 4)) : 0;
    const qk = `q${Math.max(0, Math.min(3, q))}`;
    bump(agg.byQ, qk, res);
    bump(agg.byDir, `${plan.direction}[${res.how}]`, res);
    bump(agg.byConf, `${plan.direction}:${confBucket(plan.confidence)}`, res);
    bump(agg.byAtr, `${plan.direction}:${atrBucket(atrPct)}`, res);
    bump(agg.byMfe, `${plan.direction}:${res.mfe >= 1 ? 'mfe>=1R' : 'mfe<1R'}`, res);
  }
  console.log(`${s}: rows=${rows.length} signals=${sig}`);
}
console.log(`\nВремя: ${((Date.now() - t0) / 1000).toFixed(1)} c`);

// ---- OOS: только самая свежая часть истории, если запрошено -------------------
function show(m, title) {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(m).sort()) {
    console.log(`  ${k}: n=${v.n} winrate=${(100 * v.wins / v.n).toFixed(1)}% avgR=${(v.sumR / v.n).toFixed(3)}`);
  }
}

console.log(`\nTOTAL signals=${agg.signals} filled=${agg.filled} censored=${agg.censored} n=${agg.n} avgR=${(agg.rSum / Math.max(1, agg.n)).toFixed(3)}`);
show(agg.byDir, 'по направлению [исход]');
show(agg.byConf, 'по направлению × уверенность');
show(agg.byAtr, 'по направлению × ATR%');
show(agg.byQ, 'по четвертям истории (q0 — самая старая)');
show(agg.byMfe, 'касание 1R за жизнь сделки');

// ---- Отчёт в JSON для диффа между прогонами -----------------------------------
const report = {
  savedAt: Date.now(),
  config: { interval: INTERVAL, minConf: MIN_CONF, slippageBps: SLIPPAGE_BPS, riskUsd: RISK_USD, funding: USE_FUNDING, universeSize: universe.length },
  totals: { signals: agg.signals, filled: agg.filled, censored: agg.censored, n: agg.n, avgR: agg.rSum / Math.max(1, agg.n) },
  byDir: agg.byDir, byConf: agg.byConf, byAtr: agg.byAtr, byQ: agg.byQ, byMfe: agg.byMfe,
};
// обрезаем копилочные внутренности (bump хранит объекты — пишем массивом пар)
const slim = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.n, winrate: v.wins / v.n, avgR: v.sumR / v.n }]));
report.byDir = slim(agg.byDir);
report.byConf = slim(agg.byConf);
report.byAtr = slim(agg.byAtr);
report.byQ = slim(agg.byQ);
report.byMfe = slim(agg.byMfe);
writeFileSync(join(__dirname, 'backtest-report.json'), JSON.stringify(report, null, 2));
console.log('\n→ scripts/backtest-report.json');