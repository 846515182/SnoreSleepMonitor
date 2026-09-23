# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## v1.3.0 - 2026-09-23

### 🔒 安全（P0）

- **签名密钥不再入库**：删除仓库中的 `release.keystore.b64`，CI 改用 GitHub Secrets
  （`RELEASE_KEYSTORE_BASE64` / `RELEASE_KEYSTORE_PASSWORD` / `RELEASE_KEY_ALIAS` / `RELEASE_KEY_PASSWORD`）。
  旧密钥已随仓库历史泄露，**必须轮换**（见 `SECURITY.md`）。
- 应用内更新链路加固：下载地址只接受本仓库 Releases 前缀 + 文件大小 ±1% 校验 +
  安装时 Android 签名校验；Release 附 `SHA256SUMS` 供人工核对。

### 🩺 呼吸暂停误判修复（P0）

- 新增 `ApneaTracker` 状态机，三道约束缺一不可：
  1. 连续无声**上限 60 秒**——整晚安静 + 早上闹钟不再生成横跨整晚的假“暂停”；
  2. 必须由**呼吸类声音**（鼾声/喘息）收口——梦话、环境噪声不计；
  3. 静音开始前 **5 分钟内须有呼吸声**——不打鼾的用户不再被凭空记暂停。
- 判定逻辑抽为纯函数并配套单元测试（`src/logic/__tests__/apnea.test.ts`）。

### 💾 夜间数据不丢（P0）

- 监测期间每约 30 秒写一次**增量快照**；应用被杀 / 手机重启后启动即恢复为历史记录，
  并标记 `interrupted`；不足 1 分钟的碎片不入库。
- 中断恢复的录音不可回放，直接删除，避免占空间。

### ⚙️ 版本与发布治理（P1）

- 版本号单一来源：`package.json` → `app.config.js` 自动注入 `version` 与
  `versionCode`（major\*10000+minor\*100+patch），App 内显示版本改读 `expo-constants`。
- 发布改为 **tag push（`v*`）触发**，普通 push 只跑 CI；tag 与 `package.json` 版本不一致直接失败；
  增加 `concurrency`，避免同版本互相覆盖。
- 新增 `ci.yml`（typecheck + 单元测试）与 Dependabot 周更配置。
- Release 附带 `SHA256SUMS`，发布说明自动摘录本版本 Changelog。

### 🚀 性能与存储（P1）

- 每帧 4 次全量 `filter` 统计改为 O(1) 增量累计（`totalsRef`）。
- 详情页事件列表按 `MAX_VISIBLE_EVENTS`（200 条）截断渲染，整晚千余条不再卡顿。
- 新增「是否保存整夜录音」开关与批量 WAV 写入 / 环形缓冲，降低原生侧 I/O 与存储占用。

### 🌙 明暗主题与首次引导（P1）

- 全量样式收敛为明/暗双套设计 token（`src/theme.ts` + `src/styles.ts`），
  支持「跟随系统 / 浅色 / 深色」，状态栏样式随主题切换；睡眠场景默认不再刺眼。
- **首次启动隐私同意页**：先告知后授权，同意前不请求任何系统权限（麦克风权限改在点击
  「开始睡眠监测」时申请）。
- 首页新增「高级信息」折叠（置信度 / 强度 / 峰值音量默认收起），降低信息过载。
- 设置页新增「外观主题」与「隐私与数据」入口。

### 🧪 工程化

- 逻辑层（`src/logic/*`）与展示层（`src/utils/*`）从 3100 行的 `App.tsx` 拆出，
  可独立类型检查与测试。
- 测试栈：`tsc` + Node 内置 `node --test`（不引入 jest/eslint，避免 lockfile 抖动）。
- 新增 `.gitignore`、`SECURITY.md`、`PRIVACY.md`、`docs/RELEASE.md`、issue 模板。

## v1.2.1 及更早

见仓库提交历史。
