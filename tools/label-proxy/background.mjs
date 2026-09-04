#!/usr/bin/env node
/**
 * label-proxy 的后台托管入口（Windows / macOS / Linux 通用）。
 *
 * 前台模式（node cli.mjs --service）会占用一个命令行窗口；本脚本把同一个
 * cli.mjs 以 detached 子进程方式启动，父进程立即退出，子进程在后台继续运行：
 *   - 无窗口（Windows 上 windowsHide: true）
 *   - 输出写到 run/label-proxy.log，pid 写到 run/label-proxy.pid
 *   - 再次 start 不会重复拉起（先探测 /api/status）
 *
 * 用法：
 *   node tools/label-proxy/background.mjs start
 *   node tools/label-proxy/background.mjs status
 *   node tools/label-proxy/background.mjs stop
 *   node tools/label-proxy/background.mjs restart
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(HERE, 'run');
const PID_FILE = join(RUN_DIR, 'label-proxy.pid');
const LOG_FILE = join(RUN_DIR, 'label-proxy.log');
const CLI_PATH = join(HERE, 'cli.mjs');

/** cli.mjs --service 模式的服务地址（与 cli.mjs / README 保持一致） */
const SERVICE_URL = 'http://127.0.0.1:19191';

function log(line) {
  mkdirSync(RUN_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`, 'utf8');
  console.log(line);
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fetchStatus(timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVICE_URL}/api/status`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLog(limit = 15) {
  if (!existsSync(LOG_FILE)) return '（还没有日志）';
  try {
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split(/\r?\n/);
    return lines.slice(-limit).join('\n');
  } catch {
    return '（读取日志失败）';
  }
}

/**
 * Windows 上确认 pid 确实是本工具启动的 cli.mjs 进程。
 * 只检查进程名不够：旧 pid 可能已被另一个 node 进程复用。
 */
function isLabelProxyProcess(pid) {
  if (process.platform !== 'win32') return true;
  try {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return result.status === 0 && /cli\.mjs/i.test(String(result.stdout ?? ''));
  } catch {
    return false; // 查不到命令行的进程宁可不动，避免误杀
  }
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).status === 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export async function startBackground() {
  const existing = await fetchStatus();
  if (existing) {
    log(`✔ 已在运行：${SERVICE_URL}（当前中继 ${existing.relays ?? 0} 个）`);
    return 0;
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');

  let child;
  try {
    child = spawn(process.execPath, [CLI_PATH, '--service'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    writeFileSync(PID_FILE, `${child.pid}\n`, 'utf8');
    child.unref();
  } catch (error) {
    log(`✖ 无法启动后台进程：${error?.message ?? error}`);
    return 1;
  }

  log(`正在后台启动（pid ${child.pid}）…`);

  // 最多等 3 秒让 HTTP 服务起来；失败时把日志尾部带出来，而不是静默退出。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    const status = await fetchStatus(200);
    if (status) {
      log(`✔ 已后台启动：${SERVICE_URL}（pid ${child.pid}）`);
      log(`  日志：${LOG_FILE}`);
      return 0;
    }
  }

  log(`✖ 后台启动超时，最近日志：\n${tailLog()}`);
  killProcess(child.pid);
  rmSync(PID_FILE, { force: true });
  return 1;
}

export async function stopBackground() {
  const status = await fetchStatus();
  const pid = readPid();

  if (!status) {
    if (pid) {
      log('✔ 服务未在运行，已清理旧 pid 记录');
      rmSync(PID_FILE, { force: true });
    } else {
      log('✔ 服务未在运行');
    }
    return 0;
  }

  if (!pid) {
    log('⚠ 服务正在运行，但找不到 pid 记录。');
    log('  它可能是用前台方式启动的（npm run label-proxy / node cli.mjs），');
    log('  请到启动它的窗口按 Ctrl+C，不要在这里强杀。');
    return 1;
  }

  if (!isLabelProxyProcess(pid)) {
    log(`⚠ pid ${pid} 不是本工具的 cli.mjs 进程（可能已被系统复用）；已停止操作避免误杀。`);
    log(`  请手动结束占用 ${SERVICE_URL} 的进程，并删除 ${PID_FILE}。`);
    return 1;
  }

  if (!killProcess(pid)) {
    log(`✖ 停止 pid ${pid} 失败，请手动结束占用 ${SERVICE_URL} 的进程。`);
    return 1;
  }

  // 等进程真正退出（Windows 上 taskkill /F 很快，POSIX 上给信号留一点时间）
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    if (!(await fetchStatus(200))) {
      rmSync(PID_FILE, { force: true });
      log('✔ 已停止后台服务');
      return 0;
    }
  }

  log('✖ 服务仍可访问，可能未完全退出；请检查任务管理器。');
  return 1;
}

export async function statusBackground() {
  const status = await fetchStatus();
  const pid = readPid();
  if (status) {
    log(`✔ 运行中：${SERVICE_URL}（中继 ${status.relays ?? 0} 个${pid ? `，pid ${pid}` : ''}）`);
  } else {
    log(`✖ 未运行（${SERVICE_URL} 无响应）`);
  }
  return 0;
}

function usage() {
  return `label-proxy 后台托管

用法：
  node tools/label-proxy/background.mjs <start|stop|status|restart>

说明：
  start    后台启动 cli.mjs --service，已运行则跳过
  stop     按 pid 停止后台进程
  status   查询 HTTP 服务是否在线
  restart  停止后重新启动`;
}

async function main(argv) {
  const command = argv[0] ?? 'status';
  switch (command) {
    case 'start':
      return startBackground();
    case 'stop':
      return stopBackground();
    case 'status':
      return statusBackground();
    case 'restart':
      await stopBackground();
      return startBackground();
    case '--help':
    case '-h':
    case 'help':
      console.log(usage());
      return 0;
    default:
      console.error(`未知命令：${command}\n`);
      console.error(usage());
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
