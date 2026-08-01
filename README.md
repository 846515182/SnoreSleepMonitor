# SnoreSleepMonitor 睡眠监测

一款 Android 睡眠声音监测应用（Expo / React Native）：整夜录音，设备端 YAMNet 模型实时识别**打鼾、磨牙、梦话**，并基于「连续无声时长」筛查**疑似呼吸暂停**，生成每晚的睡眠报告。

## 功能

- 🎙️ 整夜 WAV 录音（16kHz，设备端处理，音频不出手机）
- 🧠 YAMNet TFLite 模型本地推理，实时分类打鼾 / 磨牙 / 梦话 / 异常呼吸音
- 😴 呼吸暂停筛查：连续无声 ≥10 秒（可调 10–30 秒）后声音恢复，记为一次疑似暂停
- 📊 睡眠质量评分、鼾声强度分级（轻/中/重）、疑似暂停风险分级（AHI 简化版）
- ▶️ 录音回放，点击事件可直接跳转播放对应时间点
- 🔋 前台服务 + PARTIAL_WAKE_LOCK，息屏后台持续监测
- 🔄 应用内自动检查更新（GitHub Releases）并下载安装

## 隐私

所有录音与分析均在手机本地完成，**不上传任何音频或数据**。录音文件保留 3 天后自动清理，历史记录只保存在本机。

> ⚠️ 本应用的呼吸暂停筛查基于麦克风无声时长估算，仅供参考，**不构成医疗诊断**。如有疑虑请就医进行专业睡眠监测（多导睡眠图）。

## 构建

```bash
npm ci
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

推送到 `main` 分支后，GitHub Actions 会自动构建 Release 签名 APK 并发布/更新对应的 GitHub Release（tag 取自 `package.json` 的 version）。签名密钥库以 `release.keystore.b64`（Base64）形式存放在仓库根目录，构建时解码使用。

## 项目结构

- `App.tsx` — 应用主逻辑与 UI
- `plugins/withAudioMeter.js` — Expo config plugin，prebuild 时生成 Kotlin 原生模块（AudioRecord 录音 + YAMNet 推理 + 前台服务）
- `assets/yamnet/` — YAMNet TFLite 模型与类别映射表
- `.github/workflows/` — APK 构建发布与模拟器冒烟测试
