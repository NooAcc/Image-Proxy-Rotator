#!/usr/bin/env node
/**
 * 零依赖打包器：源码目录 → .zip。
 *
 * 这个 zip 有两个用途：
 *   · 用户下载后解压，在浏览器里「加载解压缩」
 *   · 直接上传到 Edge 加载项 / Chrome 应用商店（商店要的就是 zip）
 *
 * 为什么自己写而不用 zip 命令或 npm 包：
 *   · 本项目的硬约束是零运行时依赖、零构建工具，打包器也不该破例
 *   · CI 跑在 Linux、开发机是 Windows，纯 Node 实现两边行为完全一致
 *   · 时间戳固定为 1980-01-01，因此**同样的源码必然产出字节相同的包**（可复现构建）
 *
 * 用法：
 *   node tools/pack.mjs                        打包到 dist/
 *   node tools/pack.mjs --out build            换输出目录
 *   node tools/pack.mjs --check-version 1.0.0  校验 manifest 版本号（CI 发布时用）
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 进包的内容：只有浏览器真正需要的。tests / tools / docs / *.md 一律不进 */
const INCLUDE = ['manifest.json', 'src'];

// ---------------------------------------------------------------- 基础工具

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** ZIP 用的 CRC-32（与 PNG 那套多项式不同，不能共用） */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// ---------------------------------------------------------------- 收集文件

/** 递归列出目录下所有文件（相对 ROOT 的 posix 路径） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

/** manifest 里引用到的所有文件路径 */
function manifestRefs(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.options_page,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
}

/**
 * 收集要进包的文件，并顺手校验 manifest 引用的路径都在包内。
 * @returns {{name: string, data: Buffer}[]} 按路径排序，保证产物可复现
 */
export function collectFiles(root = ROOT) {
  const names = [];
  for (const item of INCLUDE) {
    const full = join(root, item);
    if (!existsSync(full)) throw new Error(`打包失败：缺少 ${item}`);
    if (statSync(full).isDirectory()) names.push(...walk(full));
    else names.push(item);
  }
  names.sort();

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const path of manifestRefs(manifest)) {
    if (!names.includes(path)) throw new Error(`打包失败：manifest 引用的 ${path} 不在包内`);
  }

  return names.map((name) => ({ name, data: readFileSync(join(root, name)) }));
}

// ---------------------------------------------------------------- ZIP

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x21; // 1980-01-01，固定值 → 可复现构建

/**
 * 打一个 zip。
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    // 压不小就直接存储，免得比原文还大
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(sum), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, body,
    ]);
    locals.push(local);

    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(sum), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--check-version') args.checkVersion = argv[++i];
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const { version } = manifest;

  if (args.checkVersion) {
    if (args.checkVersion !== version) {
      throw new Error(`版本号不一致：tag 是 ${args.checkVersion}，manifest.json 是 ${version}。`
        + '请先改 manifest.json（以及 package.json）再打 tag。');
    }
    console.log(`✔ 版本号一致：${version}`);
    return;
  }

  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });

  const entries = collectFiles();
  const zip = buildZip(entries);
  const name = `image-proxy-rotator-${version}.zip`;
  writeFileSync(join(outDir, name), zip);

  console.log(`✔ ${args.out}/${name}（${entries.length} 个文件，${(zip.length / 1024).toFixed(1)} KB）`);
  console.log('  解压后在浏览器里「加载解压缩」即可安装；此 zip 也可直接上传到应用商店。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}
