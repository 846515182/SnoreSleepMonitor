import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecordingExpired, normalizeToMs } from '../retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 3 * DAY_MS; // 与 App 中 MAX_RECORDING_AGE_MS 一致

// 固定“现在”：2026-10-10T12:00:00Z
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

test('normalizeToMs：秒级时间戳换算为毫秒', () => {
  assert.equal(normalizeToMs(1_760_000_000), 1_760_000_000_000);
});

test('normalizeToMs：毫秒时间戳原样返回', () => {
  assert.equal(normalizeToMs(1_760_000_000_000), 1_760_000_000_000);
});

test('秒单位：当天刚录的文件不过期（v1.3.0 事故回归用例）', () => {
  const seconds = Math.floor((NOW_MS - 60 * 60 * 1000) / 1000); // 1 小时前，秒
  assert.equal(isRecordingExpired(seconds, NOW_MS, MAX_AGE_MS), false);
});

test('秒单位：超过保留期的文件过期', () => {
  const seconds = Math.floor((NOW_MS - 4 * DAY_MS) / 1000); // 4 天前，秒
  assert.equal(isRecordingExpired(seconds, NOW_MS, MAX_AGE_MS), true);
});

test('毫秒单位：当天刚录的文件不过期', () => {
  assert.equal(isRecordingExpired(NOW_MS - 60 * 60 * 1000, NOW_MS, MAX_AGE_MS), false);
});

test('毫秒单位：超过保留期的文件过期', () => {
  assert.equal(isRecordingExpired(NOW_MS - 4 * DAY_MS, NOW_MS, MAX_AGE_MS), true);
});

test('保留期边界内不过期（正好 3 天整）', () => {
  // 差值恰好等于保留期时不算过期（> 才删）
  assert.equal(isRecordingExpired(NOW_MS - MAX_AGE_MS, NOW_MS, MAX_AGE_MS), false);
});

test('无效时间戳（0 / 负数）不清理', () => {
  assert.equal(isRecordingExpired(0, NOW_MS, MAX_AGE_MS), false);
  assert.equal(isRecordingExpired(-5, NOW_MS, MAX_AGE_MS), false);
});

test('未来时间戳（时钟回拨）不清理', () => {
  assert.equal(isRecordingExpired(NOW_MS + DAY_MS, NOW_MS, MAX_AGE_MS), false);
});
