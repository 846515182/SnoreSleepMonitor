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

export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea' | 'turn' | 'noise';
export type SnoreIntensity = 'mild' | 'moderate' | 'severe';

/** 一段「打鼾」至少持续 5 秒：再短就分不清是咳嗽/翻身还是真的一口鼾 */
export const MIN_SNORE_MS = 5_000;
/** 至少 4 帧被判成鼾声（0.975 秒一帧） */
export const MIN_SNORE_FRAMES = 4;
/** 鼾声帧在「有声帧」里的占比 */
export const MIN_SNORE_RATIO = 0.6;
/** 呼吸包络的最小起伏（dB，P90-P10）：稳态风扇/空调约 0–2dB，真人打鼾 6dB 以上 */
export const MIN_SNORE_MOD_DB = 2.5;
/** 至少要几个「响—停」回合 */
export const MIN_SNORE_BURSTS = 2;
/**
 * 一次连续到底、几乎没有停顿的鼾声（比如对着手机憋一口气「嘶——」）：
 * 没有呼吸回合可数，只能靠「短 + 高置信度」放行。
 * 上限 45 秒是故意的：风扇/空调会连续响一整晚，不能靠这一条混进来；
 * 而人憋一口气也不可能连续「鼾」45 秒，超过这个长度必然有换气停顿。
 */
export const STEADY_SNORE_MS = 45_000;
export const STEADY_SNORE_CONF = 0.75;
export const STEADY_SNORE_RATIO = 0.75;

export const MIN_GRIND_MS = 900; // 磨牙最小持续：至少 2 帧（0.975s 一帧，两帧相邻即 975ms）
/**
 * 单条磨牙记录的上限。
 *
 * 原实现写的是 1500ms（"磨牙一般不超过 1.5 秒"），但帧粒度就是 0.975 秒：
 * 3 帧 = 1950ms 就超上限被整段丢弃，等于只认"刚好 2 帧"的碎片，真实磨牙
 * （持续几秒到几十秒）反而记不到。现在放宽到 2 分钟，靠帧数与占比来约束。
 */
export const MAX_GRIND_MS = 120_000;
/** 磨牙至少 2 帧：单帧 0.975 秒的分不清是磨牙还是翻身摩擦 */
export const MIN_GRIND_FRAMES = 2;
/** 磨牙帧在「有声帧」里的占比 */
export const MIN_GRIND_RATIO = 0.5;

export const MIN_TALK_MS = 900; // 至少 2 帧：真实梦话常常只有一两句，2 帧 = 975ms
export const MIN_TALK_FRAMES = 2;
export const MIN_TALK_RATIO = 0.5; // 梦话帧占比门槛

/**
 * 翻身 / 床体噪声（床架吱呀、被褥摩擦、身体落床的闷响）。
 *
 * 只做「记录 + 回放」，不计入睡眠质量评分：正常人整晚翻身 20–40 次，
 * 把它算成"噪音"会让评分永远是低分，反而失真。
 */
export const MIN_TURN_MS = 900; // 至少 2 帧
export const MIN_TURN_FRAMES = 2;
export const MIN_TURN_RATIO = 0.5;
/** 单条翻身记录上限：超过 2 分钟更像是持续摩擦（空调摆风/床垫共振）而非一次翻身 */
export const MAX_TURN_MS = 120_000;

/**
 * 其他声音（环境噪音）逐条记录的门槛。
 * 至少 2 帧（约 1 秒），避免单帧爆音/点击声刷屏；单条最长 1 小时。
 * 空调、风扇这类连续底噪会被切成 1 小时一段，而不是变成一整晚的一条记录；
 * 真实的长鼾（几十分钟）也不会被切成一堆碎片。
 */
export const MIN_NOISE_MS = 900;
export const MIN_NOISE_FRAMES = 2;
/** 单条记录的最长时长：状态机在 1 小时处切段 */
export const MAX_NOISE_MS = 3_600_000;
/**
 * 静音宽限期：小于此值的静音不结束事件。
 *
 * 必须大于一个完整的「鼾声—换气」周期，否则真人每个呼吸周期都会被拆成一条事件：
 * YAMNet 一帧 0.975 秒，真人打鼾通常是「响 1–2 秒 + 停 1–2 秒」，
 * 原来的 700ms 意味着只要出现一帧换气就收尾，2 帧的碎片全部达不到帧数门槛，
 * 结果是整晚一条鼾声都记不到（已用整晚模拟复现）。
 * 5000ms 可以跨过 2–5 帧换气（真人换气、以及故意「假装打鼾」时较长的停顿），
 * 又不会把半分钟后的另一段声音并进来。
 */
export const GRACE_MS = 5000;

export interface FrameCounts {
  snore: number;
  grind: number;
  talk: number;
  /**
   * 翻身/床体噪声帧。
   * 可选：老快照/外部调用方不带这个字段时按 0 处理，不必强制改造所有调用点。
   */
  turn?: number;
  /** 其他可听声音（环境噪音）帧；可选，老快照按 0 处理 */
  noise?: number;
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
  const noiseFrames = counts.noise ?? 0;
  /**
   * 鼾声/磨牙/梦话/翻身的分母排除「其他声音」帧：
   * 风扇、空调、说话声混在鼾声事件里时，不会把鼾声帧占比稀释到门槛以下。
   * 老调用方不带 noise 字段时 typedTotal === total，行为与之前完全一致。
   */
  const typedTotal = Math.max(0, total - noiseFrames);
  const snoreRatio = typedTotal > 0 ? counts.snore / typedTotal : 0;
  const grindRatio = typedTotal > 0 ? counts.grind / typedTotal : 0;
  const talkRatio = typedTotal > 0 ? counts.talk / typedTotal : 0;
  const turnFrames = counts.turn ?? 0;
  const turnRatio = typedTotal > 0 ? turnFrames / typedTotal : 0;

  const enoughSnore =
    counts.snore >= MIN_SNORE_FRAMES &&
    snoreRatio >= MIN_SNORE_RATIO &&
    durationMs >= MIN_SNORE_MS;

  // 正常打鼾：跟着呼吸一截一截，音量有明显起伏
  const hasBreathStructure =
    enoughSnore && stats.modulationDb >= MIN_SNORE_MOD_DB && stats.bursts >= MIN_SNORE_BURSTS;

  // 一口气到底的连续鼾：没有回合可数，用「不超过 45 秒 + 高置信度」兜底
  const steadyButConfident =
    enoughSnore &&
    durationMs <= STEADY_SNORE_MS &&
    snoreRatio >= STEADY_SNORE_RATIO &&
    maxSnoreConf >= STEADY_SNORE_CONF;

  if (hasBreathStructure || steadyButConfident) {
    return { type: 'snore', intensity: classifyIntensity(maxSnoreConf) };
  }

  // 梦话：语音类声音。梦话往往只有一两句（2 帧 ≈ 1 秒），所以门槛按帧数与占比定，
  // 而不是按一个够不到的固定秒数（以前的 1.5 秒 == 至少要 3 帧，短梦话全被丢掉）。
  if (
    counts.talk >= MIN_TALK_FRAMES &&
    talkRatio >= MIN_TALK_RATIO &&
    durationMs >= MIN_TALK_MS
  ) {
    return { type: 'talk' };
  }

  // 磨牙：时长只做"至少 2 帧、单条不超过 2 分钟"的形态约束，不再用 1.5 秒硬上限。
  if (
    counts.grind >= MIN_GRIND_FRAMES &&
    grindRatio >= MIN_GRIND_RATIO &&
    durationMs >= MIN_GRIND_MS &&
    durationMs <= MAX_GRIND_MS
  ) {
    return { type: 'grind' };
  }

  // 翻身/床体噪声放在最后：只有当这一段声音既不像打鼾、也不像梦话/磨牙时才归到这里，
  // 这样翻身永远不会把真正的事件"抢走"，只会补上以前被整体丢弃的那一类声音。
  if (
    turnFrames >= MIN_TURN_FRAMES &&
    turnRatio >= MIN_TURN_RATIO &&
    durationMs >= MIN_TURN_MS &&
    durationMs <= MAX_TURN_MS
  ) {
    return { type: 'turn' };
  }

  // 其他声音兜底：所有没被归成鼾声/梦话/磨牙/翻身的可听声音，
  // 都记录为环境噪音（包括被鼾声门槛拒掉的稳态风扇、低置信度人声等）。
  // 这保证「所有声音都记录」，而不是像以前那样整段丢弃。
  if (
    total >= MIN_NOISE_FRAMES &&
    durationMs >= MIN_NOISE_MS &&
    durationMs <= MAX_NOISE_MS
  ) {
    return { type: 'noise' };
  }

  return null;
}
