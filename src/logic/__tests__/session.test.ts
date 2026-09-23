import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeSession, computeRisk, HIGH_RISK_AHI, MODERATE_RISK_AHI } from '../session';
import type { SoundEvent } from '../../types';

function evt(partial: Partial<SoundEvent> & { type: SoundEvent['type']; duration: number }): SoundEvent {
  return {
    start: partial.start ?? 0,
    end: partial.end ?? (partial.start ?? 0) + partial.duration,
    duration: partial.duration,
    type: partial.type,
    intensity: partial.intensity,
  };
}

test('computeRisk 阈值', () => {
  assert.equal(computeRisk(0), 'low');
  assert.equal(computeRisk(MODERATE_RISK_AHI - 0.1), 'low');
  assert.equal(computeRisk(MODERATE_RISK_AHI), 'moderate');
  assert.equal(computeRisk(HIGH_RISK_AHI - 0.1), 'moderate');
  assert.equal(computeRisk(HIGH_RISK_AHI), 'high');
  assert.equal(computeRisk(40), 'high');
});

test('summarizeSession 统计计数与时长', () => {
  const events: SoundEvent[] = [
    evt({ type: 'snore', duration: 2000, intensity: 'mild' }),
    evt({ type: 'snore', duration: 3000, intensity: 'severe' }),
    evt({ type: 'grind', duration: 500 }),
    evt({ type: 'talk', duration: 1000 }),
    evt({ type: 'apnea', duration: 15000 }),
  ];

  const s = summarizeSession({
    startTime: 1_000_000,
    endTime: 1_000_000 + 3600_000, // 1 小时
    events,
  });

  assert.equal(s.durationSeconds, 3600);
  assert.equal(s.snoreCount, 2);
  assert.equal(s.grindCount, 1);
  assert.equal(s.talkCount, 1);
  assert.equal(s.apneaCount, 1);
  assert.equal(s.totalSnoreSeconds, 5);
  assert.equal(s.totalGrindSeconds, 0); // 0.5s 向下取整
  assert.equal(s.totalTalkSeconds, 1);
  assert.equal(s.totalApneaSeconds, 15);
  assert.deepEqual(s.intensityBreakdown, { mild: 1, moderate: 0, severe: 1 });
  assert.equal(s.id, '1000000');
});

test('summarizeSession 的质量分不含呼吸暂停时长', () => {
  // 全程都是暂停（无声）：噪音时长为 0 -> 满分
  const s = summarizeSession({
    startTime: 0,
    endTime: 3600_000,
    events: [evt({ type: 'apnea', duration: 3_600_000 })],
  });
  assert.equal(s.qualityScore, 100, '暂停是无声区间，不应拉低质量分');
  assert.equal(s.totalApneaSeconds, 3600);
});

test('summarizeSession 疑似暂停指数与风险联动', () => {
  // 8 小时内 60 次 -> AHI = 7.5 -> 中风险
  const events: SoundEvent[] = Array.from({ length: 60 }, () =>
    evt({ type: 'apnea', duration: 12_000 })
  );
  const s = summarizeSession({ startTime: 0, endTime: 8 * 3600_000, events });
  assert.equal(s.apneaCount, 60);
  assert.equal(s.apneaRisk, 'moderate');
});

test('summarizeSession 最短时长为 1 秒，避免除零', () => {
  const s = summarizeSession({ startTime: 0, endTime: 10, events: [] });
  assert.equal(s.durationSeconds, 1);
  assert.equal(s.qualityScore, 100);
  assert.equal(s.apneaRisk, 'low');
});
