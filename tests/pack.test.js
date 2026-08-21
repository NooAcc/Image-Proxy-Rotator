/**
 * 打包器测试。
 *
 * 打包这类「一次性脚本」最容易出的问题是：产物看起来正常、浏览器却拒收。
 * 所以这里不看「函数有没有跑完」，而是用**独立写的 zip 解析器**把包拆回来，
 * 逐字节比对内容 —— 与 pack.mjs 不共用任何一行代码，避免「用同一个 bug 验证自己」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectFiles, buildZip } from '../tools/pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从中央目录读回全部条目（刻意不复用 pack.mjs 的任何代码） */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'zip 里找不到中央目录结束记录');

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, '中央目录条目签名不对');
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const rawSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    // 顺着 offset 去本地头把数据取出来
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `${name} 的本地头签名不对`);
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    assert.equal(data.length, rawSize, `${name} 解压后长度不对`);
    entries.push({ name, data, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('collectFiles 只收 manifest 与 src，不带进任何开发用文件', () => {
  const names = collectFiles(ROOT).map((f) => f.name);

  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('src/background/service-worker.js'));
  assert.ok(names.includes('src/pages/options/options.html'));
  assert.ok(names.includes('src/assets/icons/icon128.png'));

  const leaked = names.filter((n) => n.startsWith('tests/') || n.startsWith('tools/')
    || n.startsWith('docs/') || n.endsWith('.md') || n === 'package.json');
  assert.deepEqual(leaked, [], '包里不该含测试、工具、文档');
  assert.deepEqual(names, [...names].sort(), '必须按路径排序，否则产物不可复现');
});

test('zip 能被独立解析，且内容与源文件逐字节一致', () => {
  const entries = collectFiles(ROOT);
  const parsed = readZip(buildZip(entries));

  assert.equal(parsed.length, entries.length);
  for (const entry of parsed) {
    assert.deepEqual(entry.data, readFileSync(join(ROOT, entry.name)),
      `${entry.name} 解压后与源文件不一致`);
  }
});

test('同样的输入产出字节完全相同的 zip（可复现构建）', () => {
  const entries = collectFiles(ROOT);
  assert.deepEqual(buildZip(entries), buildZip(entries));
});

test('压不小的文件退回存储，不会比原文更大', () => {
  const incompressible = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) % 256));
  const [entry] = readZip(buildZip([{ name: 'a.bin', data: incompressible }]));

  assert.deepEqual(entry.data, incompressible);
  assert.equal(entry.method, 0, '这种数据 deflate 只会变大，应该走存储');
});

test('空文件与中文路径都能正确打包', () => {
  const parsed = readZip(buildZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'src/中文目录/说明.txt', data: Buffer.from('内容', 'utf8') },
  ]));

  assert.equal(parsed[0].data.length, 0);
  assert.equal(parsed[1].name, 'src/中文目录/说明.txt');
  assert.equal(parsed[1].data.toString('utf8'), '内容');
});
