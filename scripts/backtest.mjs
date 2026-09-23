// Walk-forward проверка торговых планов на истории.
// Для каждой свечи-сигнала строит план по прошлым 200 свечам и прогоняет
// бумажный движок (evaluatePosition) по будущим свечам.
// Использование: bun scripts/backtest.mjs [SYMBOL ...]  (по умолчанию топ-8 linear по обороту)
import { computeMetrics } from '../src/lib/metrics.ts';
import { buildTradePlan } from '../src/lib/tradePlan.ts';
import { evaluatePosition } from '../src/lib/paper.ts';

const INTERVAL = '5';
const WINDOW = 200;
const STEP = 5;

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`${j.retMsg} ${url}`);
  return j.result;
}

async function topSymbols(n) {
  const t = await jget('https://api.bybit.com/v5/market/tickers?category=linear');
  return t.list
    .filter((x) => Number(x.lastPrice) > 0)
    .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
    .slice(0, n)
    .map((x) => x.symbol);
}

async function klines(symbol, target = 8000) {
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
    await new Promise((r) => setTimeout(r, 120)); // вежливая пауза для лимитов
  }
  // Дедупликация на стыках страниц
  const seen = new Set();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).slice(-target);
}

const extBucket = (e) => (e < 0.5 ? '<0.5' : e < 1 ? '0.5-1' : e < 1.5 ? '1-1.5' : e < 2 ? '1.5-2' : '>=2');

function outcomeOf(ev) {
  if (ev.stopHit) return { r: -1, how: 'stop' };
  if (ev.events.some((e) => e.type === 'breakeven')) return { r: 0, how: 'breakeven' };
  if (ev.maxTp >= 3) return { r: 3, how: 'tp3' };
  return { r: 0, how: ev.maxTp > 0 ? `open-tp${ev.maxTp}` : 'open-flat' };
}

/** Приблизительный часовой тренд: EMA20/50 на 12-кратном прореживании истории. */
function htfDir(hist) {
  const hc = hist.filter((_, i) => i % 12 === 11).map((c) => c.close);
  if (hc.length < 55) return 'flat';
  const ema = (p) => {
    const k = 2 / (p + 1);
    let e = hc[0];
    for (let i = 1; i < hc.length; i++) e = hc[i] * k + e * (1 - k);
    return e;
  };
  const f = ema(20), s = ema(50);
  if (f > s * 1.001) return 'up';
  if (f < s * 0.999) return 'down';
  return 'flat';
}

/** Положение цены в диапазоне 200 свечей: 0 — у низов, 1 — у хаёв. */
function rangePos(win, price) {
  const lo = Math.min(...win.map((c) => c.low));
  const hi = Math.max(...win.map((c) => c.high));
  return hi > lo ? (price - lo) / (hi - lo) : 0.5;
}

const rpBucket = (v) => (v < 0.3 ? 'low' : v < 0.7 ? 'mid' : 'high');

const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : await topSymbols(8);
console.log('symbols:', symbols.join(', '));

const agg = { signals: 0, wait: 0, byDir: {}, byExt: {}, byHtf: {}, byRp: {}, confSum: 0, confN: 0,
  tp1hit: 0, tp2hit: 0, tp3hit: 0, stops: 0, be: 0,
  tp1exitR: 0, splitR: 0, ladderR: 0, n: 0 };

/** Доли частичного выхода на TP1 / TP2 / раннер до TP3. */
const LADDER = [0.7, 0.2, 0.1];
const bump = (m, k, r) => {
  m[k] ??= { n: 0, sumR: 0, wins: 0 };
  m[k].n += 1; m[k].sumR += r; if (r > 0) m[k].wins += 1;
};

for (const s of symbols) {
  const rows = await klines(s);
  let sig = 0;
  for (let i = WINDOW; i < rows.length - 10; i += STEP) {
    const win = rows.slice(i - WINDOW, i);
    const m = computeMetrics(win);
    if (!m) continue;
    const plan = buildTradePlan(win, m, 'linear', null, INTERVAL);
    if (!plan) continue;
    if (plan.direction === 'wait') { agg.wait += 1; continue; }
    const draft = {
      id: 'bt', symbol: s, category: 'linear', interval: INTERVAL, direction: plan.direction,
      entryPrice: plan.entryMid, stake: 100, leverage: 3, qty: 1,
      stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
      entryLow: plan.entryLow, entryHigh: plan.entryHigh, confidence: plan.confidence,
      openedAt: rows[i].time, status: 'open',
    };
    const ev = evaluatePosition(draft, rows.slice(i));
    const out = outcomeOf(ev);
    // Уровни достижимости и альтернативные схемы выхода
    if (ev.maxTp >= 1) agg.tp1hit += 1;
    if (ev.maxTp >= 2) agg.tp2hit += 1;
    if (ev.maxTp >= 3) agg.tp3hit += 1;
    if (ev.stopHit) agg.stops += 1;
    if (ev.events.some((e) => e.type === 'breakeven')) agg.be += 1;
    // Выход 100% на TP1: +1 при касании, иначе стоп −1 / безубыток 0 / открыто 0
    agg.tp1exitR += ev.maxTp >= 1 ? 1 : ev.stopHit ? -1 : 0;
    // Сплит 50/50: половина на TP1, вторая идёт до TP2/стопа/безубытка
    if (ev.maxTp >= 1) {
      const runner = ev.maxTp >= 2 ? 2 : ev.events.some((e) => e.type === 'breakeven') ? 0 : ev.stopHit ? -1 : 0;
      agg.splitR += 0.5 * 1 + 0.5 * runner;
    } else {
      agg.splitR += ev.stopHit ? -1 : 0;
    }
    // Лесенка F1/F2/F3: частичный выход на TP1/TP2, остаток до TP3/безубытка
    // (стоп после TP1 невозможен — стоит Б/У; безубыток/открыто для остатка = 0)
    if (ev.maxTp < 1) {
      agg.ladderR += ev.stopHit ? -1 : 0;
    } else {
      agg.ladderR += LADDER[0] * 1 + LADDER[1] * (ev.maxTp >= 2 ? 2 : 0) + LADDER[2] * (ev.maxTp >= 3 ? 3 : 0);
    }
    agg.n += 1;
    const ext = plan.atr > 0 ? Math.abs(plan.price - plan.ema20) / plan.atr : 0;
    const ht = htfDir(rows.slice(Math.max(0, i - 720), i));
    const rp = rangePos(win, plan.price);
    const align = (plan.direction === 'long' && ht === 'up') || (plan.direction === 'short' && ht === 'down')
      ? 'align' : ht === 'flat' ? 'htf-flat' : 'against';
    sig += 1; agg.signals += 1;
    agg.confSum += plan.confidence; agg.confN += 1;
    bump(agg.byDir, `${plan.direction} [${out.how}]`, out.r);
    bump(agg.byExt, `${plan.direction}:${extBucket(ext)}`, out.r);
    bump(agg.byHtf, `${plan.direction}:${align}`, out.r);
    bump(agg.byRp, `${plan.direction}:${rpBucket(rp)}`, out.r);
  }
  console.log(`${s}: rows=${rows.length} signals=${sig}`);
}

const show = (m) => {
  for (const [k, v] of Object.entries(m)) {
    console.log(`  ${k}: n=${v.n} winrate=${(100 * v.wins / v.n).toFixed(1)}% avgR=${(v.sumR / v.n).toFixed(3)}`);
  }
};
console.log(`\nTOTAL signals=${agg.signals} wait=${agg.wait} avgConf=${(agg.confSum / Math.max(1, agg.confN)).toFixed(1)}`);
console.log('by direction [outcome]:'); show(agg.byDir);
console.log('by direction × extension(|price-EMA20|/ATR):'); show(agg.byExt);
console.log('by direction × HTF (≈1H) alignment:'); show(agg.byHtf);
console.log('by direction × range position:'); show(agg.byRp);
console.log(`\nREACH: tp1=${(100 * agg.tp1hit / agg.n).toFixed(1)}% tp2=${(100 * agg.tp2hit / agg.n).toFixed(1)}% tp3=${(100 * agg.tp3hit / agg.n).toFixed(1)}% stops=${(100 * agg.stops / agg.n).toFixed(1)}% breakeven=${(100 * agg.be / agg.n).toFixed(1)}%`);
console.log(`EXIT-SCHEMES avgR: tp3-or-bust=${(aggAllR() / agg.n).toFixed(3)} tp1-full=${(agg.tp1exitR / agg.n).toFixed(3)} split50/50=${(agg.splitR / agg.n).toFixed(3)} ladder70/20/10=${(agg.ladderR / agg.n).toFixed(3)}`);
function aggAllR() {
  let s = 0;
  for (const m of [agg.byDir]) for (const v of Object.values(m)) s += v.sumR;
  return s;
}
