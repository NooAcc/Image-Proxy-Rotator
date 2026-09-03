/**
 * 本地标签代理命令行入口。
 *
 * 用法：
 *   node tools/label-proxy/cli.mjs --config config.json
 *   node tools/label-proxy/cli.mjs --config config.json --print-nodes
 *
 * --print-nodes 不启动服务，只打印应粘贴到扩展「批量导入」的节点行。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildPlan } from './lib/config.mjs';
import { startRelays } from './lib/relay.mjs';
import { startLabelService } from './lib/service.mjs';

export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let configPath = 'config.json';
  let printNodes = false;
  let service = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--config') {
      i += 1;
      if (!args[i]) throw new Error('--config 后缺少文件路径');
      configPath = args[i];
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else if (arg === '--print-nodes') {
      printNodes = true;
    } else if (arg === '--service') {
      service = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  const options = { configPath, printNodes };
  if (service) options.service = true;
  return options;
}

function usage() {
  return `本地标签代理

用法：
  node tools/label-proxy/cli.mjs [--config <path>] [--print-nodes]

选项：
  --config <path>    配置文件路径（默认 config.json）
  --print-nodes      只打印扩展导入行，不启动服务
  --service          以默认参数启动 HTTP 服务（无需配置文件）
  --help, -h         显示本帮助

示例配置见 tools/label-proxy/config.example.json。`;
}

export async function loadPlanFromFile(configPath) {
  const raw = await loadRawConfig(configPath);
  return buildPlan(raw);
}

export async function loadRawConfig(configPath) {
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取配置 ${configPath}：${error?.message ?? error}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${error?.message ?? error}`);
  }

  return raw;
}

async function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.service) {
    try {
      const service = await startLabelService({
        local: { baseAddress: '127.0.0.2', port: 8080 },
        service: { host: '127.0.0.1', port: 19191, token: '' },
        log: (line) => console.log(line),
      });
      console.log(`\n本地标签 HTTP 服务已启动：http://127.0.0.1:${service.port}`);
      console.log('扩展设置页「本地标签服务地址」填上面这行地址即可。');
      console.log('按 Ctrl+C 停止。');
      const stop = async () => {
        await service.close();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }

  let raw;
  try {
    raw = await loadRawConfig(options.configPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.printNodes) {
    let plan;
    try {
      plan = buildPlan(raw);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.log(plan.importLines.join('\n'));
    return;
  }

  let stop = async () => process.exit(0);

  if (raw.service && typeof raw.service === 'object') {
    try {
      const service = await startLabelService({
        local: raw.local ?? {},
        service: raw.service,
        initialUpstreams: Array.isArray(raw.upstreams) ? raw.upstreams : [],
        log: (line) => console.log(line),
      });
      console.log(`\n本地标签 HTTP 服务已启动：http://${raw.service.host ?? '127.0.0.1'}:${service.port}`);
      console.log('扩展配置好 Easy Proxies 后，同步会自动调用 /api/convert。');
      console.log('按 Ctrl+C 停止。');
      stop = async () => {
        await service.close();
        process.exit(0);
      };
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
  } else {
    let plan;
    try {
      plan = buildPlan(raw);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    let handle;
    try {
      handle = await startRelays(plan, (line) => console.log(line));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    console.log('\n本地标签代理已启动，按 Ctrl+C 停止。');
    console.log('请在扩展中导入以下节点（若已有原始同 IP 节点请先禁用或删除）：\n');
    console.log(plan.importLines.map((line) => `  ${line}`).join('\n'));

    stop = async () => {
      await handle.close();
      process.exit(0);
    };
  }

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void main();
}
