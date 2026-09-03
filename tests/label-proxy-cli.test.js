import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgv } from '../tools/label-proxy/cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'label-proxy-cli-'));

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('parseArgv 默认读取 config.json 并启动', () => {
  assert.deepEqual(parseArgv([]), { configPath: 'config.json', printNodes: false });
});

test('parseArgv 支持 --print-nodes 与 --config', () => {
  assert.deepEqual(
    parseArgv(['--config', 'local.json', '--print-nodes']),
    { configPath: 'local.json', printNodes: true },
  );
});

test('parseArgv 支持 --service 进入默认服务模式', () => {
  assert.deepEqual(parseArgv(['--service']), {
    configPath: 'config.json',
    printNodes: false,
    service: true,
  });
});

test('parseArgv 拒绝未知参数', () => {
  assert.throws(() => parseArgv(['--bogus']), /未知参数/);
});

test('cli --print-nodes 打印可直接导入扩展的节点行', () => {
  const configPath = join(tmp, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    local: { baseAddress: '127.0.0.2', port: 8080 },
    upstreams: [
      { name: 'A', host: '10.0.0.3', port: 24000 },
      { name: 'B', host: '10.0.0.3', port: 24001 },
    ],
  }));

  const result = spawnSync(
    process.execPath,
    ['tools/label-proxy/cli.mjs', '--config', configPath, '--print-nodes'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    'http://127.0.0.2:8080#A\nhttp://127.0.0.3:8080#B',
  );
});
