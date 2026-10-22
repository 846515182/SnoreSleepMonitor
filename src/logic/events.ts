/**
 * 声音事件（打鼾/磨牙/梦话）的帧聚合与分类 —— 纯逻辑，可单元测试。
 */

export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea';
export type SnoreIntensity = 'mild' | 'moderate' | 'severe';

export const MIN_SNORE_MS = 1500; // 最小打鼾持续时间 1.5 秒（约 2 个 YAMNet 帧）
export const MIN_SNORE_FRAMES = 3; // 至少 3 帧都被判成鼾声才算一次，单帧多半是误触
export const MIN_SNORE_RATIO = 0.6; // 鼾声帧占比门槛（以前 0.5 太松）
export const MIN_GRIND_MS = 300; // 最小磨牙持续时间 0.3 秒
export const MAX_GRIND_MS = 1500; // 磨牙事件一般不超过 1.5 秒
export const MIN_TALK_MS = 500; // 最小梦话持续时间 0.5 秒
export const GRACE_MS = 700; // 静音宽限期：小于此值的静音不结束事件

export interface FrameCounts {
  snore: number;
  grind: number;
  talk: number;
  total: number;
}

export interface ClassifiedEvent {
  type: Exclude<SoundEventType, 'apnea'>;
  intensity?: SnoreIntensity;
}

/** 由单帧最高打鼾置信度推导强度分级 */
export function classifyIntensity(conf: number): SnoreIntensity {
  if (conf >= 0.75) return 'severe';
  if (conf >= 0.55) return 'moderate';
  return 'mild';
}

/**
 * 事件结束时按帧比例与持续时间归类。
 * @returns 不满足任何类型的最小时长/比例时返回 null（该段声音被丢弃）
 */
export function classifyFinalEvent(
  durationMs: number,
  counts: FrameCounts,
  maxSnoreConf: number
): ClassifiedEvent | null {
  const total = counts.total > 0 ? counts.total : 0;
  const snoreRatio = total > 0 ? counts.snore / total : 0;
  const grindRatio = total > 0 ? counts.grind / total : 0;
  const talkRatio = total > 0 ? counts.talk / total : 0;

  if (
    counts.snore >= MIN_SNORE_FRAMES &&
    snoreRatio >= MIN_SNORE_RATIO &&
    durationMs >= MIN_SNORE_MS
  ) {
    return { type: 'snore', intensity: classifyIntensity(maxSnoreConf) };
  }
  if (talkRatio >= 0.5 && durationMs >= MIN_TALK_MS) {
    return { type: 'talk' };
  }
  if (grindRatio >= 0.3 && durationMs >= MIN_GRIND_MS && durationMs <= MAX_GRIND_MS) {
    return { type: 'grind' };
  }
  return null;
}
