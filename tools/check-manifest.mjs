/**
 * 加载扩展**之前**的静态校验。
 *
 * 浏览器对 manifest 路径笔误和 ESM 相对路径笔误的报错都很晦涩（往往只是 SW
 * 静默不启动），所以在这里一次性查清：
 *   1. manifest.json 合法且是 MV3
 *   2. manifest 引用的每个文件真的存在
 *   3. src/ 下所有 import 的相对路径都能解析到实际文件
 *   3b. 命名导入必须真的被目标模块导出（删除/重命名导出时最容易留下悬空导入）
 *   4. src/lib/ 里没有出现 chrome.*（守护「纯逻辑层可单测」这条架构约束，决策 D6）
 *   4b. UI 发出的每个消息类型都有对应的后台 handler
 *   5. HTML 引用的 css/js 都存在
 *   6. 两个页面各自的 html/css/js 都在位
 *
 * 用法：npm run check
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function fail(message) {
  problems.push(message);
}

function rel(path) {
  return relative(ROOT, path).split('\\').join('/');
}

function mustExist(path, why) {
  if (!existsSync(join(ROOT, path))) fail(`${why}：找不到文件 ${path}`);
}

// ---- 1 & 2：manifest 本身与它引用的文件 ----

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`manifest.json 无法解析：${e.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail(`manifest_version 必须是 3，当前是 ${manifest.manifest_version}`);
  if (!manifest.name) fail('manifest 缺少 name');
  if (!manifest.version) fail('manifest 缺少 version');

  const sw = manifest.background?.service_worker;
  if (!sw) fail('manifest 缺少 background.service_worker');
  else mustExist(sw, 'Service Worker');
  if (manifest.background?.type !== 'module') fail('background.type 必须是 "module"（代码使用 ESM）');

  if (manifest.options_page) mustExist(manifest.options_page, '设置页');
  else fail('manifest 缺少 options_page');

  if (manifest.action?.default_popup) mustExist(manifest.action.default_popup, '弹窗页');
  else fail('manifest 缺少 action.default_popup');

  for (const [size, path] of Object.entries(manifest.icons ?? {})) mustExist(path, `icons.${size}`);
  for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
    mustExist(path, `action.default_icon.${size}`);
  }

  const required = ['proxy', 'storage', 'alarms', 'webRequest', 'webRequestAuthProvider'];
  for (const permission of required) {
    if (!manifest.permissions?.includes(permission)) fail(`manifest.permissions 缺少 "${permission}"`);
  }

  // content_scripts：路径笔误的后果是「重试功能整块静默失效」，浏览器不会报错
  for (const [index, entry] of (manifest.content_scripts ?? []).entries()) {
    for (const path of entry.js ?? []) mustExist(path, `content_scripts[${index}].js`);
    for (const path of entry.css ?? []) mustExist(path, `content_scripts[${index}].css`);
    if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
      fail(`content_scripts[${index}] 缺少 matches`);
    }
    // 内容脚本不是模块（MV3 不支持），所以里面出现 import 语句会让整个脚本注入失败
    for (const path of entry.js ?? []) {
      const full = join(ROOT, path);
      if (!existsSync(full)) continue;
      const source = readFileSync(full, 'utf8');
      if (/^\s*(?:import|export)\s/m.test(source)) {
        fail(`${path} 是 content script，不能含 import/export —— MV3 的 content_scripts 不支持 ESM`);
      }
    }
  }

  checkDynamicContentScripts();
}

/**
 * 动态注册的内容脚本（深度重试的桥与补丁，决策 D31）。
 *
 * 它们在 manifest 里一行都没有，所以上面那一段完全碰不到 —— 而它们同样是 classic
 * script、同样不能有 import，路径写错同样只会在注册那一刻失败。手写一份清单会跟代码
 * 脱节，所以从注入器源码里把路径抠出来。
 */
function checkDynamicContentScripts() {
  const injector = join(ROOT, 'src', 'background', 'deep-retry-injector.js');
  if (!existsSync(injector)) return;

  const source = readFileSync(injector, 'utf8');
  const paths = [...new Set([...source.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]))];
  if (paths.length === 0) {
    fail('deep-retry-injector.js 里找不到任何要注册的脚本路径，注入范围无从校验');
  }

  for (const path of paths) {
    const full = join(ROOT, path);
    if (!existsSync(full)) {
      fail(`${path} 会被动态注册，但文件不存在 —— 注册那一刻才会失败，且只在活动日志里`);
      continue;
    }
    if (/^\s*(?:import|export)\s/m.test(readFileSync(full, 'utf8'))) {
      fail(`${path} 是动态注册的 content script，不能含 import/export`);
    }
  }
}

// ---- 工具：递归列出文件 ----

function walk(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry)) out.push(full);
  }
  return out;
}

// ---- 3：ESM 相对路径 ----

const jsFiles = walk(join(ROOT, 'src'), (name) => name.endsWith('.js'));
const IMPORT_RE = /\b(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec || !spec.startsWith('.')) continue; // 只查相对路径
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) fail(`${rel(file)} 里的 import "${spec}" 指向不存在的文件`);
  }
}

// ---- 3b：命名导入必须真的被目标模块导出 ----
// 删除或重命名导出时最容易留下悬空导入，而浏览器只会静默不启动 SW。

/** 收集一个模块导出的所有名字 */
function exportedNames(file) {
  const source = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const parts = piece.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (name) names.add(name);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) names.add('default');
  if (/^\s*export\s+\*/m.test(source)) names.add('*');
  return names;
}

const exportCache = new Map();
const NAMED_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;

for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const target = resolve(dirname(file), match[2]);
    if (!existsSync(target)) continue; // 上一步已报过

    if (!exportCache.has(target)) exportCache.set(target, exportedNames(target));
    const available = exportCache.get(target);
    if (available.has('*')) continue; // 有再导出，静态判断不可靠，跳过

    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name)) {
        fail(`${rel(file)} 从 "${match[2]}" 导入了 ${name}，但该模块并未导出它`);
      }
    }
  }
}

// ---- 4：src/lib 不得引用 chrome.* ----

for (const file of walk(join(ROOT, 'src', 'lib'), (name) => name.endsWith('.js'))) {
  const source = readFileSync(file, 'utf8');
  // 先把块注释挖空（用空格替换，保留换行以维持行号），再逐行去掉行注释。
  // 注释里提到 chrome 是允许的 —— 那里正是解释「为什么不能用」的地方。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  code.split(/\r?\n/).forEach((line, index) => {
    if (/\bchrome\s*\./.test(line.replace(/\/\/.*$/, ''))) {
      fail(`${rel(file)}:${index + 1} 引用了 chrome.*，但 src/lib 必须保持零浏览器依赖（决策 D6）`);
    }
  });
}

// ---- 4b：UI 与内容脚本发出的每个消息类型都必须有后台 handler ----
// 契约只靠字符串维系，写错一个字母浏览器不会报错，只会静默什么都不做。

const messagingFile = join(ROOT, 'src', 'background', 'messaging.js');
if (existsSync(messagingFile)) {
  const source = readFileSync(messagingFile, 'utf8');
  const handlersBlock = /const handlers = \{([\s\S]*?)\n\};/.exec(source);
  if (!handlersBlock) {
    fail('messaging.js 里找不到 handlers 对象，无法校验消息契约');
  } else {
    const handlerNames = new Set(
      [...handlersBlock[1].matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]),
    );

    // 页面走 shared/api.js 的 send('type')；内容脚本没法 import 它，
    // 只能直接 chrome.runtime.sendMessage({type: 'x'})，所以两种写法都要扫
    const senders = [
      { dir: join(ROOT, 'src', 'pages'), re: /\bsend\(\s*['"]([^'"]+)['"]/g },
      { dir: join(ROOT, 'src', 'content'), re: /\btype:\s*['"]([^'"]+)['"]/g },
    ];
    for (const { dir, re } of senders) {
      for (const file of walk(dir, (name) => name.endsWith('.js'))) {
        const pageSource = readFileSync(file, 'utf8');
        for (const m of pageSource.matchAll(re)) {
          if (!handlerNames.has(m[1])) {
            fail(`${rel(file)} 发送了消息 "${m[1]}"，但 messaging.js 里没有对应的 handler`);
          }
        }
      }
    }
  }
}

// ---- 5：HTML 引用的资源 ----
const htmlFiles = walk(join(ROOT, 'src'), (name) => name.endsWith('.html'));
const ASSET_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/g;

for (const file of htmlFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(ASSET_RE)) {
    const spec = match[1];
    if (/^(https?:|data:|#|mailto:)/.test(spec)) continue;
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) fail(`${rel(file)} 引用的资源 "${spec}" 不存在`);
  }
}

// ---- 6：页面数量自检（防止漏建文件）----

for (const path of [
  'src/pages/options/options.html',
  'src/pages/options/options.css',
  'src/pages/options/options.js',
  'src/pages/popup/popup.html',
  'src/pages/popup/popup.css',
  'src/pages/popup/popup.js',
  'src/pages/shared/tokens.css',
  'src/pages/shared/components.css',
  'src/pages/shared/api.js',
  'src/pages/shared/ui.js',
]) {
  mustExist(path, '页面文件');
}

// ---- 汇总 ----

if (problems.length > 0) {
  console.error(`✖ manifest 校验未通过，共 ${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`✔ manifest 校验通过（检查了 ${jsFiles.length} 个 JS 文件、${htmlFiles.length} 个 HTML 文件）`);
