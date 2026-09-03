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

export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let configPath = 'config.json';
  let printNodes = false;

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
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return { configPath, printNodes };
}

function usage() {
  return `本地标签代理

用法：
  node tools/label-proxy/cli.mjs [--config <path>] [--print-nodes]

选项：
  --config <path>    配置文件路径（默认 config.json）
  --print-nodes      只打印扩展导入行，不启动服务
  --help, -h         显示本帮助

示例配置见 tools/label-proxy/config.example.json。`;
}

export async function loadPlanFromFile(configPath) {
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

  return buildPlan(raw);
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

  let plan;
  try {
    plan = await loadPlanFromFile(options.configPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.printNodes) {
    console.log(plan.importLines.join('\n'));
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

  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void main();
}
