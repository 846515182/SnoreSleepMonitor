import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFinalEvent,
  classifyIntensity,
  MIN_GRIND_MS,
  MAX_GRIND_MS,
  MIN_SNORE_MS,
  MIN_TALK_MS,
} from '../events';

test('classifyIntensity 按置信度分三档', () => {
  assert.equal(classifyIntensity(0.8), 'severe');
  assert.equal(classifyIntensity(0.6), 'moderate');
  assert.equal(classifyIntensity(0.2), 'mild');
  assert.equal(classifyIntensity(0.75), 'severe');
  assert.equal(classifyIntensity(0.55), 'moderate');
});

test('打鼾：占比 >= 0.6、至少 3 帧、时长 >= 1.5 秒', () => {
  const evt = classifyFinalEvent(2000, { snore: 7, grind: 2, talk: 1, total: 10 }, 0.8);
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.intensity, 'severe');
});

test('打鼾帧只有 2 帧 -> 不记（单次误触最常见的形态）', () => {
  const evt = classifyFinalEvent(3000, { snore: 2, grind: 8, talk: 0, total: 10 }, 0.9);
  assert.notEqual(evt?.type, 'snore');
});

test('打鼾占比 0.55（旧门槛能过）-> 现在不记', () => {
  const evt = classifyFinalEvent(3000, { snore: 55, grind: 45, talk: 0, total: 100 }, 0.9);
  assert.notEqual(evt?.type, 'snore');
});

test('打鼾时长不足 -> 降级尝试其他类型', () => {
  const evt = classifyFinalEvent(MIN_SNORE_MS - 1, { snore: 9, grind: 0, talk: 1, total: 10 }, 0.3);
  assert.equal(evt, null, '不足 0.5s 的打鼾应被丢弃');
});

test('梦话：占比 >= 0.6 且至少 1.5 秒（单帧 0.975 秒的误判不再记）', () => {
  const evt = classifyFinalEvent(2000, { snore: 0, grind: 0, talk: 8, total: 10 }, 0);
  assert.equal(evt?.type, 'talk');

  // 单帧 = 0.975 秒：环境人声/咳嗽，不够 1.5 秒
  assert.equal(classifyFinalEvent(975, { snore: 0, grind: 0, talk: 2, total: 2 }, 0), null);
  // 时长够了但占比只有 0.5
  assert.equal(classifyFinalEvent(2000, { snore: 0, grind: 0, talk: 5, total: 10 }, 0), null);
});

test('梦话时长不足 -> 丢弃', () => {
  const evt = classifyFinalEvent(MIN_TALK_MS - 1, { snore: 0, grind: 0, talk: 10, total: 10 }, 0);
  assert.equal(evt, null);
});

test('磨牙：占比 >= 0.3 且时长在 0.3–1.5s 之间', () => {
  const ok = classifyFinalEvent(800, { snore: 2, grind: 3, talk: 0, total: 10 }, 0);
  assert.equal(ok?.type, 'grind');

  const tooShort = classifyFinalEvent(MIN_GRIND_MS - 1, { snore: 0, grind: 5, talk: 0, total: 10 }, 0);
  assert.equal(tooShort, null);

  const tooLong = classifyFinalEvent(MAX_GRIND_MS + 1, { snore: 0, grind: 5, talk: 0, total: 10 }, 0);
  assert.equal(tooLong, null);
});

test('所有类型都不满足 -> null（避免把环境噪声记为事件）', () => {
  const evt = classifyFinalEvent(5_000, { snore: 1, grind: 1, talk: 1, total: 10 }, 0.9);
  assert.equal(evt, null);
});

test('空帧集合不抛异常', () => {
  assert.equal(classifyFinalEvent(1_000, { snore: 0, grind: 0, talk: 0, total: 0 }, 0.5), null);
});
