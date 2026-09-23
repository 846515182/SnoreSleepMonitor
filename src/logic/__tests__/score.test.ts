import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersion, parseVersion } from '../version';
import { calculateQualityScore } from '../score';

test('parseVersion 去掉 v 前缀并解析数字段', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.1'), [1, 2, 1]);
  assert.deepEqual(parseVersion('1.10'), [1, 10]);
});

test('compareVersion 逐段比较', () => {
  assert.equal(compareVersion('1.2.1', '1.2.1'), 0);
  assert.equal(compareVersion('1.2.1', '1.3.0'), -1);
  assert.equal(compareVersion('1.10.0', '1.9.0'), 1, '必须按数字比较而非字符串比较');
  assert.equal(compareVersion('v2.0.0', '1.9.9'), 1);
  // 段数不一致时补 0
  assert.equal(compareVersion('1.2', '1.2.1'), -1);
  assert.equal(compareVersion('1.2.1', '1.2'), 1);
});

test('calculateQualityScore 边界情况', () => {
  assert.equal(calculateQualityScore(0, 0), 100, '无时长时给满分，避免除零');
  assert.equal(calculateQualityScore(3600, 0), 100, '整晚安静 -> 100 分');
  assert.equal(calculateQualityScore(3600, 3600), 0, '全程噪声 -> 0 分');
  assert.equal(calculateQualityScore(3600, 100_000), 0, '噪声超时长时被夹紧到 0');
});

test('calculateQualityScore 单调不增', () => {
  let prev = 101;
  for (const noiseRatio of [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1]) {
    const score = calculateQualityScore(3600, 3600 * noiseRatio);
    assert.ok(score <= prev, `噪声比例上升时分数不应上升（ratio=${noiseRatio}）`);
    assert.ok(score >= 0 && score <= 100, '分数必须落在 0-100');
    prev = score;
  }
});
