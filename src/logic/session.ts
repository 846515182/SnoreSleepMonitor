/**
 * 从事件列表汇总出一条睡眠会话记录 —— 纯函数，可单元测试。
 *
 * 这里集中了「计数 / 时长 / 强度分布 / 疑似暂停指数 / 风险分级 / 质量评分」的全部口径，
 * 正常停止监测与崩溃恢复两条路径共用同一套统计，避免口径漂移。
 */

import type { ApneaRisk, SleepSession, SoundEvent } from '../types';
import { calculateQualityScore } from './score';

/** AHI 简化版阈值（疑似暂停次数 / 小时）：>=15 高风险，>=5 中风险 */
export const HIGH_RISK_AHI = 15;
export const MODERATE_RISK_AHI = 5;

export interface SummarizeInput {
  startTime: number;
  endTime: number;
  events: SoundEvent[];
  recordingUri?: string;
  eventsTruncated?: boolean;
  /** 监测被中断后恢复的记录 */
  interrupted?: boolean;
}

function sumByType(events: SoundEvent[], type: SoundEvent['type']): {
  count: number;
  ms: number;
} {
  let count = 0;
  let ms = 0;
  for (const e of events) {
    if (e.type === type) {
      count += 1;
      ms += e.duration;
    }
  }
  return { count, ms };
}

export function computeRisk(ahi: number): ApneaRisk {
  if (ahi >= HIGH_RISK_AHI) return 'high';
  if (ahi >= MODERATE_RISK_AHI) return 'moderate';
  return 'low';
}

export function summarizeSession(input: SummarizeInput): SleepSession {
  const durationSeconds = Math.max(
    1,
    Math.floor((input.endTime - input.startTime) / 1000)
  );

  const snore = sumByType(input.events, 'snore');
  const grind = sumByType(input.events, 'grind');
  const talk = sumByType(input.events, 'talk');
  const apnea = sumByType(input.events, 'apnea');

  const totalSnoreSeconds = Math.floor(snore.ms / 1000);
  const totalGrindSeconds = Math.floor(grind.ms / 1000);
  const totalTalkSeconds = Math.floor(talk.ms / 1000);
  const totalApneaSeconds = Math.floor(apnea.ms / 1000);

  // 声音时长与质量分不含呼吸暂停（暂停是无声区间，不是噪音）
  const totalNoiseSeconds = totalSnoreSeconds + totalGrindSeconds + totalTalkSeconds;

  const intensityBreakdown = {
    mild: input.events.filter((e) => e.type === 'snore' && e.intensity === 'mild').length,
    moderate: input.events.filter((e) => e.type === 'snore' && e.intensity === 'moderate').length,
    severe: input.events.filter((e) => e.type === 'snore' && e.intensity === 'severe').length,
  };

  // 疑似暂停指数：疑似暂停事件数 / 监测小时数（筛查参考，非医学 AHI）
  const hours = durationSeconds / 3600;
  const ahi = hours > 0 ? apnea.count / hours : 0;

  return {
    id: `${input.startTime}`,
    startTime: input.startTime,
    endTime: input.endTime,
    durationSeconds,
    events: input.events,
    snoreCount: snore.count,
    grindCount: grind.count,
    talkCount: talk.count,
    apneaCount: apnea.count,
    totalSnoreSeconds,
    totalGrindSeconds,
    totalTalkSeconds,
    totalApneaSeconds,
    recordingUri: input.recordingUri,
    qualityScore: calculateQualityScore(durationSeconds, totalNoiseSeconds),
    apneaRisk: computeRisk(ahi),
    intensityBreakdown,
    eventsTruncated: input.eventsTruncated,
    interrupted: input.interrupted,
  };
}
