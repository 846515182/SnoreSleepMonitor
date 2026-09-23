# SnoreSleepMonitor 睡眠监测

一款 Android 睡眠声音监测应用（Expo / React Native）：整夜录音，设备端 YAMNet 模型实时识别**打鼾、磨牙、梦话**，并基于「连续无声时长」筛查**疑似呼吸暂停**，生成每晚的睡眠报告。

## 功能

- 🎙️ 整夜 WAV 录音（16kHz，设备端处理，音频不出手机），可在设置中关闭录音、只识别不落盘
- 🧠 YAMNet TFLite 模型本地推理，实时分类打鼾 / 磨牙 / 梦话 / 异常呼吸音
- 😴 呼吸暂停筛查：连续无声 ≥10 秒（可调 10–30 秒）后由**呼吸类声音**收口才记为一次疑似暂停，
  并带上限 60 秒与 5 分钟呼吸上下文两道约束，杜绝“整晚安静 + 闹钟 = 假暂停”
- 📊 睡眠质量评分、鼾声强度分级（轻/中/重）、疑似暂停风险分级（AHI 简化版）
- ▶️ 录音回放，点击事件可直接跳转播放对应时间点
- 🔋 前台服务 + PARTIAL_WAKE_LOCK，息屏后台持续监测
- 💾 监测期间每 30 秒写一次快照：应用被杀 / 重启后自动恢复当夜记录
- 🌙 明 / 暗双主题（跟随系统 / 浅色 / 深色），夜间不刺眼
- 🛡️ 首次启动先展示隐私说明，用户同意后才可能请求麦克风权限
- 🔄 应用内检查更新（GitHub Releases），下载地址白名单 + 大小校验 + 签名校验

## 隐私

所有录音与分析均在手机本地完成，**不上传任何音频或数据**。录音文件保留 3 天后自动清理，
历史记录只保存在本机。详见 [PRIVACY.md](PRIVACY.md)。

> ⚠️ 本应用的呼吸暂停筛查基于麦克风无声时长估算，仅供参考，**不构成医疗诊断**。
> 如有疑虑请就医进行专业睡眠监测（多导睡眠图）。

## 开发

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # 编译纯逻辑层并跑 node --test 单元测试
npm start           # expo start
```

测试栈刻意只用 `tsc` + Node 内置 `node --test`：不引入 jest/eslint，避免 lockfile 抖动。

## 版本号（单一来源）

**只改 `package.json` 的 `version`**：`app.config.js` 会据此推导 Expo `version` 与 Android
`versionCode`（`major*10000 + minor*100 + patch`），App 内显示的版本号通过 `expo-constants` 读取，
三处永远一致。

## 构建与发布

签名材料**不在仓库里**，构建前需在仓库
`Settings → Secrets and variables → Actions` 配置（详见 [SECURITY.md](SECURITY.md)）：

| Secret | 说明 |
| --- | --- |
| `RELEASE_KEYSTORE_BASE64` | `base64 -w0 release.keystore` |
| `RELEASE_KEYSTORE_PASSWORD` | 密码 |
| `RELEASE_KEY_ALIAS` | 别名（如 `snoresleep`） |
| `RELEASE_KEY_PASSWORD` | 与 `RELEASE_KEYSTORE_PASSWORD` 相同（PKCS12 不支持独立 keypass） |

本地构建：

```bash
npm ci
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

发布：改版本 → 更新 CHANGELOG → 打 `vX.Y.Z` tag 并推送，
`build-apk.yml` 会校验 tag 与 `package.json` 一致、跑测试、构建并创建 GitHub Release
（附 APK + `SHA256SUMS`）。推 `main` 只跑 `ci.yml`（typecheck + 测试），不会产生 Release。
完整流程见 [docs/RELEASE.md](docs/RELEASE.md)。

## 项目结构

- `App.tsx` — 页面与流程编排（业务规则已下沉到 `src/logic`）
- `src/logic/` — 纯逻辑：呼吸暂停状态机、事件分类、会话汇总、评分、版本比较
- `src/logic/__tests__/` — 单元测试（`node --test`）
- `src/theme.ts`、`src/styles.ts` — 明 / 暗设计 token 与样式工厂
- `src/utils/` — 展示层格式化与文案/语义色
- `plugins/withAudioMeter.js` — Expo config plugin，prebuild 时生成 Kotlin 原生模块
  （AudioRecord 录音 + YAMNet 推理 + 前台服务）
- `assets/yamnet/` — YAMNet TFLite 模型与类别映射表
- `.github/workflows/` — CI、APK 构建发布与模拟器冒烟测试

## 安全

签名密钥曾以 `release.keystore.b64` 形式提交进仓库，**该密钥已泄露、必须轮换**，
当前代码已改为从 GitHub Secrets 读取。详见 [SECURITY.md](SECURITY.md)。
