/**
 * 领域类型定义（原 App.tsx 内联定义，抽出以供 UI / 逻辑 / 测试共用）。
 */

export type SoundEventType = 'snore' | 'grind' | 'talk' | 'apnea';
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
  totalSnoreSeconds: number;
  totalGrindSeconds: number;
  totalTalkSeconds: number;
  totalApneaSeconds: number;
  recordingUri?: string;
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
