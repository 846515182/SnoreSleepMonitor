/**
 * 录音保留期判断 —— 纯函数，可单元测试。
 *
 * expo-file-system 的 getInfoAsync().modificationTime 单位在不同平台/版本间并不
 * 一致（iOS 返回秒；Android 曾返回毫秒，新版实现换算为秒）。直接与 Date.now()
 * （毫秒）相减会因单位错位把「今天刚录的」误判为几十年前、从而在每次启动时删光
 * 全部录音（v1.3.0–v1.4.2 的事故根因）。这里统一归一化成毫秒再比较。
 */

/** 秒级时间戳 ~1.7e9，毫秒级 ~1.7e12，以 1e11 为界安全区分两种单位 */
const MS_THRESHOLD = 1e11;

/** 把可能为秒或毫秒的时间戳统一换算为毫秒 */
export function normalizeToMs(timestamp: number): number {
  return timestamp < MS_THRESHOLD ? timestamp * 1000 : timestamp;
}

/**
 * 判断录音文件是否已超过保留期。
 *
 * @param modificationTime 文件修改时间（秒或毫秒均可，内部归一化）
 * @param nowMs            当前时间（毫秒）
 * @param maxAgeMs         保留期长度（毫秒）
 */
export function isRecordingExpired(
  modificationTime: number,
  nowMs: number,
  maxAgeMs: number
): boolean {
  if (!(modificationTime > 0)) return false; // 无有效时间戳时不清理，宁可多留不可误删
  return nowMs - normalizeToMs(modificationTime) > maxAgeMs;
}
