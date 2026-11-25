/**
 * 领域类型定义（原 App.tsx 内联定义，抽出以供 UI / 逻辑 / 测试共用）。
 */

/**
 * 事件类型：
 * - snore / grind / talk：声音事件（计入睡眠质量评分）
 * - apnea：疑似呼吸暂停（无声段）
 * - turn：翻身 / 床体噪声（床垫、床架、被褥摩擦与身体落床的闷响）
 *   属于正常睡眠行为，只做记录与回放，不计入质量评分
 * - noise：其他可听声音（咳嗽、喷嚏、说话、狗叫、开关门、家电、交通等），
 *   用 YAMNet 原始类别生成中文文字标签后逐条记录，同样不计入质量评分
 */
export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea' | 'turn' | 'noise';
export type SnoreIntensity = 'mild' | 'moderate' | 'severe';

export interface SoundEvent {
  /** 相对会话开始的毫秒数 */
  start: number;
  end: number;
  /** 毫秒 */
  duration: number;
  type: SoundEventType;
  /** 仅用于打鼾强度分级 */
  intensity?: SnoreIntensity;
  /**
   * 识别到的具体声音文字（仅 noise 事件使用），例如「咳嗽」「狗叫」「说话声」。
   * 由 YAMNet 原始类别映射而来；没有可读标签时为 undefined，界面显示为「环境噪音」。
   */
  soundLabel?: string;
  /** 静音时长超过上限时被截断（保留字段，当前策略下不产生） */
  capped?: boolean;
  /**
   * 在「裁剪后的鼾声文件」里的可播放起点（毫秒）。
   * 默认录音是整晚原文件，这两个字段为空；开启「只保存鼾声片段」后，
   * 音频文件只剩鼾声，原来的 start/end 已经对不上，必须用这两个偏移回放。
   */
  playStart?: number;
  playEnd?: number;
}

export type ApneaRisk = 'low' | 'moderate' | 'high';

export type AudioQualityLevel = 'good' | 'fair' | 'poor';

/**
 * 录音质量结论：由覆盖率、削波率、环境底噪与信噪比汇总而来。
 * 识别再准也需要可信的音频输入，这一项用于提示用户调整手机位置/环境。
 */
export interface AudioQuality {
  level: AudioQualityLevel;
  /** 实际收到的音频帧 / 应产生的帧，0–1 */
  coverage: number;
  /** 削波帧占比，0–1 */
  clippedRatio: number;
  /** 有效声音平均高出底噪的 dB 数（无样本时为 0） */
  avgSnrDb: number;
  /** 结束时估计的环境底噪（dBFS） */
  noiseFloorDb: number;
  /** 面向用户的中文原因，可直接展示 */
  issues: string[];
}

export interface SleepSession {
  id: string;
  startTime: number;
  endTime?: number;
  durationSeconds: number;
  events: SoundEvent[];
  snoreCount: number;
  grindCount: number;
  talkCount: number;
  apneaCount: number;
  /** 翻身 / 床体噪声次数（正常生理行为，不计入质量评分） */
  turnCount: number;
  /** 其他可听声音（环境噪音）次数 */
  noiseCount: number;
  totalSnoreSeconds: number;
  totalGrindSeconds: number;
  totalTalkSeconds: number;
  totalApneaSeconds: number;
  totalTurnSeconds: number;
  /** 环境噪音累计时长（秒） */
  totalNoiseSeconds: number;
  recordingUri?: string;
  /** snore = 音频已裁成只剩鼾声片段；full = 整晚原始录音 */
  recordingMode?: 'snore' | 'full';
  /** 声音维度评分 0-100 */
  qualityScore: number;
  /** 疑似呼吸暂停风险分级 */
  apneaRisk?: ApneaRisk;
  /** 事件数超上限被截断 */
  eventsTruncated?: boolean;
  /** 鼾声强度分布 */
  intensityBreakdown?: { mild: number; moderate: number; severe: number };
  /** 录音质量评估（旧会话/兼容模式可能没有） */
  audioQuality?: AudioQuality;
  /** 监测是否被中断（应用被杀 / 重启后恢复） */
  interrupted?: boolean;
}

export type Screen = 'home' | 'history' | 'detail' | 'settings';

export type ThemePreference = 'system' | 'light' | 'dark';
