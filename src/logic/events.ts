/**
 * 声音事件（打鼾/磨牙/梦话）的帧聚合与分类 —— 纯逻辑，可单元测试。
 *
 * 为什么打鼾不能只看「YAMNet 说是 snoring」：
 * 公开的鼾声检测研究（如 Gonzalez-Martinez 等，Applied Acoustics 2024）指出，
 * 鼾声的本质特征是**谐波结构 + 随呼吸周期起伏的能量包络**；
 * 而 AudioSet 的 snoring 类是在 YouTube 音频上训出来的，风扇、空调、路噪、
 * 电视里的呼吸声都可能被打上 0.6–0.8 的分数。
 * 所以这里除了置信度和时长，还要求：
 *   - 这一段的音量有起伏（真人打鼾每 2–4 秒一个呼吸周期，静音段和鼾声段差 10dB 以上；
 *     风扇/空调是稳态噪声，音量几乎不变）；
 *   - 至少有 2 个「响—停」回合，或者连续响了足够久。
 * 这两条能把绝大部分稳态噪声挡掉，又不会误伤真人（真人不可能一直用完全相同的音量打鼾）。
 */

export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea';
export type SnoreIntensity = 'mild' | 'moderate' | 'severe';

/** 一段「打鼾」至少持续 10 秒：真人打鼾是按分钟算的，几秒钟的响声基本都是翻身/咳嗽/环境音 */
export const MIN_SNORE_MS = 10_000;
/** 至少 6 帧被判成鼾声（0.975 秒一帧），约 3 个呼吸周期 */
export const MIN_SNORE_FRAMES = 6;
/** 鼾声帧在「有声帧」里的占比 */
export const MIN_SNORE_RATIO = 0.6;
/** 呼吸包络的最小起伏（dB，P90-P10）：稳态风扇/空调约 0–2dB，真人打鼾 10dB 以上 */
export const MIN_SNORE_MOD_DB = 3;
/** 至少要几个「响—停」回合；连续不断的长鼾用时长兜底 */
export const MIN_SNORE_BURSTS = 2;
/** 连续（没有明显停顿）时，至少这么长才认 */
export const MIN_CONTINUOUS_SNORE_MS = 12_000;

export const MIN_GRIND_MS = 300; // 最小磨牙持续时间 0.3 秒
export const MAX_GRIND_MS = 1500; // 磨牙事件一般不超过 1.5 秒
export const MIN_TALK_MS = 1500; // 最小梦话持续时间 1.5 秒：单帧 0.975 秒的“梦话”几乎都是环境人声、咳嗽、电视
export const MIN_TALK_RATIO = 0.6; // 梦话帧占比门槛
/**
 * 静音宽限期：小于此值的静音不结束事件。
 *
 * 必须大于一个完整的「鼾声—换气」周期，否则真人每个呼吸周期都会被拆成一条事件：
 * YAMNet 一帧 0.975 秒，真人打鼾通常是「响 1–2 秒 + 停 1–2 秒」，
 * 原来的 700ms 意味着只要出现一帧换气就收尾，2 帧的碎片全部达不到帧数门槛，
 * 结果是整晚一条鼾声都记不到（已用整晚模拟复现）。
 * 3000ms 可以跨过 1–3 帧换气，又不会把半分钟后的另一段声音并进来。
 */
export const GRACE_MS = 3000;

export interface FrameCounts {
  snore: number;
  grind: number;
  talk: number;
  total: number;
}

/**
 * 一段事件里与「是不是真鼾声」有关的统计量。
 * 这不是可有可无的装饰：稳态噪声和真人打鼾在置信度上区分不开，
 * 只能靠包络起伏和呼吸回合数来区分。
 */
export interface EpisodeStats {
  /** 整段事件（含换气停顿）的音量 P90-P10，dB */
  modulationDb: number;
  /** 连续鼾声帧的段数（响—停回合数） */
  bursts: number;
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

/** 分位数（线性插值），输入会被排序 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 事件结束时按帧比例、持续时间、包络起伏归类。
 * @returns 不满足任何类型的最小时长/比例时返回 null（该段声音被丢弃）
 */
export function classifyFinalEvent(
  durationMs: number,
  counts: FrameCounts,
  maxSnoreConf: number,
  stats: EpisodeStats
): ClassifiedEvent | null {
  const total = counts.total > 0 ? counts.total : 0;
  const snoreRatio = total > 0 ? counts.snore / total : 0;
  const grindRatio = total > 0 ? counts.grind / total : 0;
  const talkRatio = total > 0 ? counts.talk / total : 0;

  const hasSnoreShape =
    counts.snore >= MIN_SNORE_FRAMES &&
    snoreRatio >= MIN_SNORE_RATIO &&
    durationMs >= MIN_SNORE_MS &&
    stats.modulationDb >= MIN_SNORE_MOD_DB &&
    (stats.bursts >= MIN_SNORE_BURSTS || durationMs >= MIN_CONTINUOUS_SNORE_MS);

  if (hasSnoreShape) {
    return { type: 'snore', intensity: classifyIntensity(maxSnoreConf) };
  }
  if (talkRatio >= MIN_TALK_RATIO && durationMs >= MIN_TALK_MS) {
    return { type: 'talk' };
  }
  if (grindRatio >= 0.3 && durationMs >= MIN_GRIND_MS && durationMs <= MAX_GRIND_MS) {
    return { type: 'grind' };
  }
  return null;
}
