/**
 * 版本号单一来源：package.json -> Expo 配置（app.config.js 优先于 app.json 生效）。
 *
 * 过去 version / versionCode 分别硬编码在 package.json、app.json 和 App.tsx 三处，
 * 极易漂移（App 曾出现 UI 显示版本与实际构建版本不一致）。
 * 现在只改 package.json 的 version，构建号与 App 内显示版本自动跟随。
 *
 * 这里显式读取并展开 app.json：无论 Expo 是否做静态/动态配置合并，
 * 本文件给出的结果都是完整配置，避免依赖隐式合并语义。
 */

const pkg = require('./package.json');
const base = require('./app.json').expo;

/** 语义版本 -> versionCode：major*10000 + minor*100 + patch（上限 2147483647） */
function versionToCode(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return major * 10000 + minor * 100 + patch;
}

module.exports = {
  expo: {
    ...base,
    version: pkg.version,
    android: {
      ...base.android,
      versionCode: versionToCode(pkg.version),
    },
    ios: {
      ...base.ios,
      supportsTablet: true,
      bundleIdentifier: 'com.snoresleep.monitor',
    },
    // 支持系统级深色模式（App 内另有「跟随系统 / 浅色 / 深色」偏好）
    userInterfaceStyle: 'automatic',
  },
};
