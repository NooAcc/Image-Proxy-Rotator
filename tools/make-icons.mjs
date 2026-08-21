/**
 * 零依赖 PNG 图标生成器。
 *
 * 手写最小 PNG 编码器（IHDR + IDAT + IEND，node:zlib 做 deflate），
 * 这样仓库里不需要引入任何图形库，也不需要把二进制图标签进版本库来源不明。
 *
 * 图案：深蓝圆角方块 + 一竖三横的「分流」符号（一个入口分出三条线路）。
 *
 * 用法：npm run icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [31, 42, 68];        // 深蓝底
const FG = [240, 246, 255];     // 近白前景
const ACCENT = [96, 176, 255];  // 中间那条线用亮蓝，强调「正在分流」

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行的过滤器类型：None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 图案绘制 ----------

/** 圆角矩形的内部判定（归一化坐标 0..1） */
function inRoundedRect(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius + 1e-9;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的距离，用来画有粗细的斜线 */
function distToSegment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / lenSq));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return Math.hypot(x - px, y - py);
}

/**
 * 返回该点的前景颜色，或 null 表示没有前景。
 *
 * 图案：左侧一个实心圆点（单一入口），向右分出三条斜线并各自以一个小方块收尾
 * （三个出口）—— 即「一个请求流被分散到多个节点」。
 */
function foregroundAt(x, y) {
  const originX = 0.26;
  const originY = 0.5;
  const endX = 0.78;
  const lineHalf = 0.035;
  const targets = [
    { y: 0.24, color: FG },
    { y: 0.50, color: ACCENT },
    { y: 0.76, color: FG },
  ];

  // 入口圆点
  if (inCircle(x, y, originX, originY, 0.10)) return FG;

  for (const target of targets) {
    // 分出去的斜线
    if (distToSegment(x, y, originX, originY, endX, target.y) <= lineHalf) return target.color;
    // 出口方块
    if (inRect(x, y, endX - 0.06, target.y - 0.06, endX + 0.06, target.y + 0.06)) return target.color;
  }
  return null;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3; // 3x3 超采样做抗锯齿
  const radius = 0.22;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      let fgR = 0;
      let fgG = 0;
      let fgB = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (!inRoundedRect(x, y, radius)) continue;
          bgHits++;
          const fg = foregroundAt(x, y);
          if (fg) {
            fgHits++;
            fgR += fg[0];
            fgG += fg[1];
            fgB += fg[2];
          }
        }
      }

      const total = samples * samples;
      const alpha = Math.round((bgHits / total) * 255);
      const offset = (py * size + px) * 4;
      if (alpha === 0) continue;

      // 前景占比作为混合权重，得到平滑边缘
      const w = bgHits > 0 ? fgHits / bgHits : 0;
      const r = fgHits > 0 ? fgR / fgHits : 0;
      const g = fgHits > 0 ? fgG / fgHits : 0;
      const b = fgHits > 0 ? fgB / fgHits : 0;

      rgba[offset] = Math.round(BG[0] * (1 - w) + r * w);
      rgba[offset + 1] = Math.round(BG[1] * (1 - w) + g * w);
      rgba[offset + 2] = Math.round(BG[2] * (1 - w) + b * w);
      rgba[offset + 3] = alpha;
    }
  }

  return encodePng(size, size, rgba);
}

// ---------- 主流程 ----------

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = renderIcon(size);
  const path = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`✔ 已生成 ${path}（${png.length} 字节）`);
}
console.log(`共生成 ${SIZES.length} 个图标。`);
