import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFinalEvent,
  classifyIntensity,
  percentile,
  MIN_GRIND_MS,
  MAX_GRIND_MS,
  MIN_SNORE_MS,
  MIN_TALK_MS,
} from '../events';
import type { EpisodeStats } from '../events';

/** 一段「像真打鼾」的统计量：响—停 5 个回合，音量起伏 12dB */
const snoreShape: EpisodeStats = { meanSnoreConf: 0.7, modulationDb: 12, bursts: 5 };

test('classifyIntensity 按置信度分三档', () => {
  assert.equal(classifyIntensity(0.8), 'severe');
  assert.equal(classifyIntensity(0.6), 'moderate');
  assert.equal(classifyIntensity(0.2), 'mild');
  assert.equal(classifyIntensity(0.75), 'severe');
  assert.equal(classifyIntensity(0.55), 'moderate');
});

test('percentile：中位数与边界', () => {
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([3, 1, 2], 0), 1);
  assert.equal(percentile([3, 1, 2], 1), 3);
  assert.equal(percentile([], 0.5), 0);
});

test('打鼾：>= 6 帧、占比 >= 0.6、>= 10 秒、有呼吸包络', () => {
  const evt = classifyFinalEvent(20_000, { snore: 20, grind: 2, talk: 1, total: 25 }, 0.8, snoreShape);
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.intensity, 'severe');
});

test('稳态噪声（风扇/空调）：置信度高、时间也长，但音量几乎不变 -> 不记', () => {
  const steady: EpisodeStats = { meanSnoreConf: 0.78, modulationDb: 1.5, bursts: 1 };
  const evt = classifyFinalEvent(60_000, { snore: 60, grind: 0, talk: 0, total: 60 }, 0.8, steady);
  assert.equal(evt, null);
});

test('打鼾帧只有 2 帧 -> 不记（单次误触最常见的形态）', () => {
  const evt = classifyFinalEvent(3000, { snore: 2, grind: 8, talk: 0, total: 10 }, 0.9, snoreShape);
  assert.notEqual(evt?.type, 'snore');
});

test('打鼾占比 0.55（旧门槛能过）-> 现在不记', () => {
  const evt = classifyFinalEvent(30_000, { snore: 55, grind: 45, talk: 0, total: 100 }, 0.9, snoreShape);
  assert.notEqual(evt?.type, 'snore');
});

test('平均置信度被拉低（用户把阈值调得太低）-> 不记', () => {
  const weak: EpisodeStats = { meanSnoreConf: 0.4, modulationDb: 12, bursts: 5 };
  const evt = classifyFinalEvent(20_000, { snore: 20, grind: 0, talk: 0, total: 20 }, 0.5, weak);
  assert.equal(evt, null);
});

test('只有一个回合、又不到 12 秒 -> 不记（多半是一次咳嗽/翻身）', () => {
  const oneBurst: EpisodeStats = { meanSnoreConf: 0.7, modulationDb: 8, bursts: 1 };
  const evt = classifyFinalEvent(11_000, { snore: 11, grind: 0, talk: 0, total: 11 }, 0.7, oneBurst);
  assert.equal(evt, null, '11 秒的单次爆发不足以判成打鼾');
  const long = classifyFinalEvent(14_000, { snore: 14, grind: 0, talk: 0, total: 14 }, 0.7, oneBurst);
  assert.equal(long?.type, 'snore', '连续 14 秒可以认');
});

test('打鼾时长不足 -> 丢弃', () => {
  const evt = classifyFinalEvent(MIN_SNORE_MS - 1, { snore: 9, grind: 0, talk: 1, total: 10 }, 0.3, snoreShape);
  assert.equal(evt, null);
});

test('梦话：占比 >= 0.6 且至少 1.5 秒（单帧 0.975 秒的误判不再记）', () => {
  const evt = classifyFinalEvent(2000, { snore: 0, grind: 0, talk: 8, total: 10 }, 0, snoreShape);
  assert.equal(evt?.type, 'talk');

  // 单帧 = 0.975 秒：环境人声/咳嗽，不够 1.5 秒
  assert.equal(classifyFinalEvent(975, { snore: 0, grind: 0, talk: 2, total: 2 }, 0, snoreShape), null);
  // 时长够了但占比只有 0.5
  assert.equal(classifyFinalEvent(2000, { snore: 0, grind: 0, talk: 5, total: 10 }, 0, snoreShape), null);
});

test('梦话时长不足 -> 丢弃', () => {
  const evt = classifyFinalEvent(MIN_TALK_MS - 1, { snore: 0, grind: 0, talk: 10, total: 10 }, 0, snoreShape);
  assert.equal(evt, null);
});

test('磨牙：占比 >= 0.3 且时长在 0.3–1.5s 之间', () => {
  const ok = classifyFinalEvent(800, { snore: 2, grind: 3, talk: 0, total: 10 }, 0, snoreShape);
  assert.equal(ok?.type, 'grind');

  const tooShort = classifyFinalEvent(MIN_GRIND_MS - 1, { snore: 0, grind: 5, talk: 0, total: 10 }, 0, snoreShape);
  assert.equal(tooShort, null);

  const tooLong = classifyFinalEvent(MAX_GRIND_MS + 1, { snore: 0, grind: 5, talk: 0, total: 10 }, 0, snoreShape);
  assert.equal(tooLong, null);
});

test('所有类型都不满足 -> null（避免把环境噪声记为事件）', () => {
  const evt = classifyFinalEvent(5_000, { snore: 1, grind: 1, talk: 1, total: 10 }, 0.9, snoreShape);
  assert.equal(evt, null);
});

test('空帧集合不抛异常', () => {
  assert.equal(
    classifyFinalEvent(1_000, { snore: 0, grind: 0, talk: 0, total: 0 }, 0.5, snoreShape),
    null
  );
});
