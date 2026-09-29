/**
 * Генерация PNG-иконок PWA без зависимостей: рисуем пиксели сами и пакуем в PNG
 * (zlib из node). Запуск: `bun scripts/gen-icons.mjs`
 *
 * Иконка — тёмный квадрат со скруглением, свеча и стрелка вверх (зелёная,
 * как в интерфейсе) — тот же язык, что у графика в приложении.
 * Рисуем с 4× суперсэмплингом и усредняем: получаем мягкие края без шумов.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));
const SS = 4; // суперсэмплинг

const C = {
  bgTop: [0x16, 0x1b, 0x24],
  bgBottom: [0x0b, 0x0d, 0x10],
  pos: [0x26, 0xa6, 0x9a],
  accent: [0x3b, 0x82, 0xf6],
  text: [0xd7, 0xdc, 0xe3],
};

/** Пиксель с альфой: [r, g, b, a] либо null (прозрачно). */
function draw(x, y, size, pad) {
  const u = x / size;
  const v = y / size;
  // Скругление: вне радиуса — прозрачно (maskable-иконке нужен сплошной фон,
  // поэтому для неё скругление не рисуем — подробности в buildIcon).
  if (pad > 0) {
    const r = pad;
    const cx = u < r ? r : u > 1 - r ? 1 - r : u;
    const cy = v < r ? r : v > 1 - r ? 1 - r : v;
    const dx = u - cx;
    const dy = v - cy;
    if (Math.hypot(dx, dy) > r) return null;
  }
  // Фон: вертикальный градиент.
  const t = v;
  const bg = C.bgTop.map((c, i) => Math.round(c + (C.bgBottom[i] - c) * t));
  // Свеча: тело 0.30–0.62 по X, 0.34–0.60 по Y; фитили 0.24–0.70.
  const bodyX0 = 0.3;
  const bodyX1 = 0.46;
  const bodyY0 = 0.42;
  const bodyY1 = 0.6;
  const wickX0 = 0.365;
  const wickX1 = 0.395;
  const wickY0 = 0.3;
  const wickY1 = 0.7;
  let px = bg;
  if (u >= wickX0 && u <= wickX1 && v >= wickY0 && v <= wickY1) px = C.pos;
  if (u >= bodyX0 && u <= bodyX1 && v >= bodyY0 && v <= bodyY1) px = C.pos;

  // Стрелка вверх-вправо: ломаная (0.5,0.62) → (0.62,0.5) → (0.78,0.24)
  // и наконечник. Рисуем отрезки thickened-ом (расстояние до отрезка < w/2).
  const segs = [
    [0.52, 0.6, 0.63, 0.49],
    [0.63, 0.49, 0.79, 0.25],
  ];
  const w = 0.055;
  for (const [x1, y1, x2, y2] of segs) {
    if (distToSeg(u, v, x1, y1, x2, y2) < w / 2) px = C.pos;
  }
  // Наконечник: две короткие палки от верхушки (0.79, 0.25)
  if (
    distToSeg(u, v, 0.79, 0.25, 0.66, 0.24) < w / 2 ||
    distToSeg(u, v, 0.79, 0.25, 0.8, 0.38) < w / 2
  ) px = C.pos;

  // Подпись-полоса снизу (имитация таблицы): серая линия, чтобы иконка не была пустой.
  if (v >= 0.86 && v <= 0.885 && u >= 0.24 && u <= 0.62) px = C.text;
  return [...px, 255];
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Собрать RGBA-буфер размера size×size со сглаживанием. */
function buildIcon(size, { pad = 0, solidBg = false } = {}) {
  const n = size * SS;
  const acc = new Float64Array(size * size * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = draw((x + 0.5) / n, (y + 0.5) / n, 1, solidBg ? 0 : pad);
      if (!p) continue;
      const oi = (Math.floor(y / SS) * size + Math.floor(x / SS)) * 4;
      acc[oi] += p[0];
      acc[oi + 1] += p[1];
      acc[oi + 2] += p[2];
      acc[oi + 3] += 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / samples; // 0..255
    if (a <= 0.5) {
      out[i * 4 + 3] = 0;
      continue;
    }
    // усредняем только по покрытым субсэмплам, иначе края темнеют
    const covered = acc[i * 4 + 3] / 255;
    out[i * 4] = Math.round(acc[i * 4] / covered);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / covered);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / covered);
    out[i * 4 + 3] = Math.round(a);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Минимальный валидный PNG: 8 бит, RGBA (colorType 6), без фильтра строк. */
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });

const files = [
  // Обычные иконки: скруглённый квадрат (как favicon).
  ['icon-192.png', 192, { pad: 0.16 }],
  ['icon-512.png', 512, { pad: 0.16 }],
  // maskable: сплошной фон, рисунок внутри безопасной зоны (центр 80 %).
  ['icon-maskable-512.png', 512, { solidBg: true }],
  ['apple-touch-icon.png', 180, { pad: 0 }],
];

for (const [name, size, opts] of files) {
  const png = encodePng(size, buildIcon(size, opts));
  writeFileSync(OUT + name, png);
  console.log(`${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} КБ`);
}
