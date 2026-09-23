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

test('打鼾：帧占比 >= 0.5 且时长达标', () => {
  const evt = classifyFinalEvent(1000, { snore: 6, grind: 2, talk: 2, total: 10 }, 0.8);
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.intensity, 'severe');
});

test('打鼾时长不足 -> 降级尝试其他类型', () => {
  const evt = classifyFinalEvent(MIN_SNORE_MS - 1, { snore: 9, grind: 0, talk: 1, total: 10 }, 0.3);
  assert.equal(evt, null, '不足 0.5s 的打鼾应被丢弃');
});

test('梦话：talk 占比 >= 0.5', () => {
  const evt = classifyFinalEvent(800, { snore: 2, grind: 0, talk: 8, total: 10 }, 0);
  assert.equal(evt?.type, 'talk');
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
