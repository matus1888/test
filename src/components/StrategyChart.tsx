import { useMemo } from 'react';
import type { Candle } from '../api/bybit';
import type { TradePlan } from '../lib/tradePlan';
import { fmtTime } from '../lib/paper';
import Term from './Term';

const UP = '#26a69a';
const DOWN = '#ef5350';
const LIQ = '#f6465d';
const W = 900;
const H = 380;
const PAD_L = 8;
const PAD_R = 64;
const PAD_T = 16;
const VOL_H = 56;
const PRICE_H = H - PAD_T - VOL_H - 24;

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = values[0];
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Вертикальный маркер события (вход/выход): линия по времени + подпись. */
export interface ChartMarker {
  time: number;
  label: string;
  color: string;
}

/** SVG-график стратегии: свечи + EMA + зона входа + стоп + тейки. Без зависимостей. */
export default function StrategyChart(
  { candles, plan, markers = [], liqPrice = null, decimals = 4 }: {
    candles: Candle[]; plan: TradePlan; markers?: ChartMarker[]; liqPrice?: number | null; decimals?: number;
  },
) {
  const view = useMemo(() => {
    const data = candles.slice(-120);
    const n = data.length;
    if (n < 5) return null;
    const closes = data.map((c) => c.close);
    const e20 = emaSeries(closes, 20);
    const e50 = emaSeries(closes, 50);

    const levels = plan.direction === 'wait'
      ? [plan.recentHigh, plan.recentLow]
      : [plan.entryLow, plan.entryHigh, plan.stop, plan.tp1, plan.tp2, plan.tp3];
    let lo = Math.min(...data.map((c) => c.low), ...levels);
    let hi = Math.max(...data.map((c) => c.high), ...levels);
    if (!(hi > lo)) return null;

    // Ликвидация: втискиваем в масштаб, только если она рядом (в пределах
    // половины видимого диапазона за краем), иначе покажем метку у края.
    const liq = liqPrice != null && Number.isFinite(liqPrice) && liqPrice > 0 ? liqPrice : null;
    const span0 = hi - lo;
    const liqShown = liq != null && liq > lo - span0 * 0.5 && liq < hi + span0 * 0.5;
    if (liqShown && liq != null) {
      lo = Math.min(lo, liq);
      hi = Math.max(hi, liq);
    }
    const pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;

    const pw = W - PAD_L - PAD_R;
    const step = pw / n;
    const bw = Math.max(1.5, step * 0.62);
    const y = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * PRICE_H;
    const x = (i: number) => PAD_L + i * step + step / 2;

    const vmax = Math.max(...data.map((c) => c.volume), 1e-9);
    const volY = (v: number) => H - 12 - (v / vmax) * VOL_H;

    // Маркеры событий → индексы свечей. События старше видимого окна
    // пропускаем, события новее последней свечи клеим к правому краю.
    const marks = markers.map((mk, j) => {
      let idx = data.findIndex((c) => c.time >= mk.time);
      if (idx === -1) idx = mk.time >= data[n - 1].time ? n - 1 : -1;
      return { mk, idx, j };
    }).filter((x) => x.idx >= 0);

    return { data, n, e20, e50, lo, hi, y, x, step, bw, volY, marks, liq, liqShown };
  }, [candles, plan, markers, liqPrice]);

  if (!view) return null;
  const { data, n, e20, e50, y, x, bw, volY, marks, liq, liqShown } = view;
  const wait = plan.direction === 'wait';

  const line = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const hline = (price: number, color: string, dash: string, label: string, lv: string) => (
    <g key={label}>
      <line x1={PAD_L} x2={W - PAD_R} y1={y(price)} y2={y(price)} stroke={color} strokeWidth={1.2} strokeDasharray={dash} />
      <rect x={W - PAD_R + 2} y={y(price) - 9} width={PAD_R - 4} height={18} rx={3} fill={color} opacity={0.9} />
      <text x={W - PAD_R + 6} y={y(price) + 4} fontSize={10} fill="#0b0d10" fontWeight={700}>{lv}</text>
    </g>
  );

  const zoneTop = y(Math.max(plan.entryLow, plan.entryHigh));
  const zoneBot = y(Math.min(plan.entryLow, plan.entryHigh));

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span>{wait ? 'Диапазон 20 свечей' : plan.direction === 'long' ? 'Лонг-зона' : 'Шорт-зона'}</span>
        <Term t="ema" label="Линии: EMA20 голубая · EMA50 оранжевая" />
        {marks.length > 0 && <span>Вход/выход — вертикальный пунктир со временем</span>}
        {liq != null && <Term t="liq" label={`LIQ ~${liq.toFixed(decimals)} — оценка ликвидации`} />}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img">
        {/* зона входа / диапазон */}
        <rect
          x={PAD_L} width={W - PAD_L - PAD_R}
          y={zoneTop} height={Math.max(2, zoneBot - zoneTop)}
          fill={wait ? '#8b93a1' : '#3b82f6'} opacity={0.12}
        />
        {/* объём */}
        {data.map((c, i) => (
          <rect
            key={`v${i}`} x={x(i) - bw / 2} width={bw}
            y={volY(c.volume)} height={Math.max(1, H - 12 - volY(c.volume))}
            fill={c.close >= c.open ? UP : DOWN} opacity={0.45}
          />
        ))}
        {/* свечи */}
        {data.map((c, i) => {
          const up = c.close >= c.open;
          const col = up ? UP : DOWN;
          const yO = y(c.open), yC = y(c.close);
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
              <rect
                x={x(i) - bw / 2} width={bw}
                y={Math.min(yO, yC)} height={Math.max(1, Math.abs(yC - yO))}
                fill={col}
              />
            </g>
          );
        })}
        {/* EMA */}
        <path d={line(e20)} fill="none" stroke="#3b82f6" strokeWidth={1.4} />
        <path d={line(e50)} fill="none" stroke="#f59e0b" strokeWidth={1.4} />
        {/* уровни стратегии */}
        {wait ? (
          <>
            {hline(plan.recentHigh, UP, '5 3', 'high', 'MAX')}
            {hline(plan.recentLow, DOWN, '5 3', 'low', 'MIN')}
          </>
        ) : (
          <>
            {hline(plan.tp3, UP, '5 3', 'tp3', 'TP3')}
            {hline(plan.tp2, UP, '5 3', 'tp2', 'TP2')}
            {hline(plan.tp1, UP, '5 3', 'tp1', 'TP1')}
            {hline(plan.entryMid, '#3b82f6', '2 2', 'entry', 'IN')}
            {hline(plan.stop, DOWN, '6 3', 'stop', 'STOP')}
          </>
        )}
        {/* ликвидация: линия в масштабе либо метка у края */}
        {liq != null && liqShown && hline(liq, LIQ, '6 3', 'liq', 'LIQ')}
        {liq != null && !liqShown && (
          <g>
            {liq > view.hi ? (
              <polygon points={`${W - PAD_R - 8},${PAD_T + 12} ${W - PAD_R + 8},${PAD_T + 12} ${W - PAD_R},${PAD_T + 2}`} fill={LIQ} />
            ) : (
              <polygon points={`${W - PAD_R - 8},${H - 24} ${W - PAD_R + 8},${H - 24} ${W - PAD_R},${H - 14}`} fill={LIQ} />
            )}
            <text
              x={W - PAD_R} y={liq > view.hi ? PAD_T + 26 : H - 28}
              fontSize={10} fill={LIQ} fontWeight={700} textAnchor="end"
            >
              LIQ ~{liq.toFixed(decimals)}
            </text>
          </g>
        )}
        {/* маркеры входа/выхода */}
        {marks.map(({ mk, idx, j }) => {
          const lx = Math.min(Math.max(x(idx), 70), W - PAD_R - 70);
          return (
            <g key={`m${j}`}>
              <line x1={x(idx)} x2={x(idx)} y1={PAD_T} y2={H - 12} stroke={mk.color} strokeWidth={1} strokeDasharray="3 3" opacity={0.85} />
              <text x={lx} y={11} fontSize={10} fill={mk.color} fontWeight={700} textAnchor="middle">
                {mk.label} · {fmtTime(mk.time)}
              </text>
            </g>
          );
        })}
        {/* подписи мин/макс */}
        <text x={PAD_L} y={14} fontSize={10} fill="#8b93a1">
          {view.hi.toFixed(4)} ··· {view.lo.toFixed(4)} · последние {n} свечей
        </text>
      </svg>
    </div>
  );
}
