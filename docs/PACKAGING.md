# 打包与分发

本项目零构建，日常开发直接「加载解压缩」源码目录就行。这份文档只在**要分发给别人**时才需要。

---

## 产物只有一个：zip

| 想干什么 | 做法 |
|---|---|
| 自己用 / 给别人装 | `npm run pack` → 把 `dist/page-proxy-<版本>.zip` 发出去，对方解压后「加载解压缩」 |
| 上架 Edge 加载项 / Chrome 应用商店 | 同一个 zip 直接上传，商店要的就是它 |

**不产出 `.crx`**：开发人员模式解锁的是「加载解压缩」，不等于「安装本地 crx」——
自签名 crx 拖进现代 Chromium 通常会以缺少应用商店签名（`CRX_REQUIRED_PROOF_MISSING`）为由被拒，
或者装上后被标为非商店来源并自动停用。真要走 crx 只有企业策略自托管一条路，
不属于本项目的目标场景，因此不做。

---

## 本地打包

```bash
npm run pack       # 打包到 dist/
npm run release    # 先跑全部测试与静态校验，再打包
```

更细的参数：

```bash
node tools/pack.mjs --out build              # 换输出目录
node tools/pack.mjs --check-version 1.0.0    # 只校验 manifest 版本号（CI 发布时用）
```

打包器（`tools/pack.mjs`）的几个刻意设计：

- **零依赖**：zip 是手写的（只用 `node:zlib`），不引入 npm 包，Windows 与 Linux 行为一致。
- **可复现**：时间戳固定为 1980-01-01，同样的源码必然产出**字节相同**的包。
- **只装该装的**：包里只有 `manifest.json` 和 `src/`，`tests/` `tools/` `docs/` `*.md` 一律不进，
  并且会校验 manifest 引用的每个文件都在包内。这两条由 `tests/pack.test.js` 守着。
- **测试不信自己**：`tests/pack.test.js` 用**另写一份**的 zip 解析器把包拆回来逐字节比对，
  避免「用同一个 bug 验证自己」。

---

## GitHub Actions

工作流在 `.github/workflows/build.yml`：

| 事件 | 行为 |
|---|---|
| 推主分支 / 提 PR / 手动触发 | Node 20 + 22 上跑全部测试与静态校验 → 打 zip → 传 Artifacts |
| 推 `v*` 标签 | 上面全部 + 校验 tag 与 manifest 版本一致 + 建 Release 并附上 zip |

它刻意**不跑 `npm install` / `npm ci`** —— 本项目零依赖，没有 `package-lock.json`，
`npm ci` 只会失败，而我们也确实不需要装任何东西。工作流里还有一步专门校验
`dependencies` / `devDependencies` 保持为空。

发布一个版本：

```bash
# 1. 改版本号（manifest.json 与 package.json 都要改，两者必须一致）
# 2. 提交后打 tag 并推送
git tag v1.0.1
git push origin v1.0.1
```

tag 与 `manifest.json` 的版本不一致时流水线会**直接失败**并说明原因 ——
刻意不自动改文件，否则会出现「发布产物的版本号和仓库里的对不上」这种事后无法追查的情况。

> 当前目录还不是 git 仓库（见 plan.md 的 O4）。工作流要生效，需要先 `git init`、
> 提交代码并推到 GitHub。
