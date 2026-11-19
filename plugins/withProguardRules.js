/**
 * 给 android/app/proguard-rules.pro 追加 expo-av 的兼容规则。
 *
 * 背景（Expo SDK 58 / expo-av 16）：
 *   expo-av 的 FullscreenVideoPlayer$KeepScreenOnUpdater 仍引用
 *   expo.modules.core.interfaces.services.KeepAwakeManager，
 *   但该接口在 SDK 58 里已被移除（keep-awake 走 expo-keep-awake 模块）。
 *   本项目只用 expo-av 的音频接口（iOS 兜底播放 / 录音），视频路径不可达，
 *   于是 release 构建在 R8 阶段报 "Missing class ... " 直接失败。
 *   给 R8 加 dontwarn，让混淆跳过这个不可达引用。
 */

const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# snore-sleep: expo-av SDK58 兼容';

const RULES = [
  MARKER,
  '# expo-av 16 的视频播放器引用了 SDK 58 已移除的 KeepAwakeManager，',
  '# 本项目只用音频接口，该引用不可达，允许 R8 忽略缺失类。',
  '-dontwarn expo.modules.core.interfaces.services.KeepAwakeManager',
  '-dontwarn expo.modules.core.interfaces.services.**',
  '',
].join('\n');

module.exports = createRunOncePlugin(
  function withProguardRules(config) {
    return withDangerousMod(config, [
      'android',
      async (cfg) => {
        const file = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
        if (!fs.existsSync(file)) {
          console.warn('[withProguardRules] 未找到 proguard-rules.pro，跳过');
          return cfg;
        }
        const content = fs.readFileSync(file, 'utf8');
        if (!content.includes(MARKER)) {
          fs.writeFileSync(file, `${content.trimEnd()}\n\n${RULES}`, 'utf8');
        }
        return cfg;
      },
    ]);
  },
  'withProguardRules',
  '1.0.0'
);
