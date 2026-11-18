/**
 * 领域类型定义（原 App.tsx 内联定义，抽出以供 UI / 逻辑 / 测试共用）。
 */

/**
 * 事件类型：
 * - snore / grind / talk：声音事件（计入睡眠质量评分）
 * - apnea：疑似呼吸暂停（无声段）
 * - turn：翻身 / 床体噪声（床垫、床架、被褥摩擦与身体落床的闷响）
 *   属于正常睡眠行为，只做记录与回放，不计入质量评分
 */
export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea' | 'turn';
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
  totalSnoreSeconds: number;
  totalGrindSeconds: number;
  totalTalkSeconds: number;
  totalApneaSeconds: number;
  totalTurnSeconds: number;
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
  /** 监测是否被中断（应用被杀 / 重启后恢复） */
  interrupted?: boolean;
}

export type Screen = 'home' | 'history' | 'detail' | 'settings';

export type ThemePreference = 'system' | 'light' | 'dark';
