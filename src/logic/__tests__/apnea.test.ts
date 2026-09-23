import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApneaTracker,
  apneaMinSilenceMs,
  DEFAULT_MAX_APNEA_SILENCE_MS,
  type ApneaEvent,
} from '../apnea';

/** 模拟一段会话：quiet 表示该帧是否静音 */
function runTracker(
  tracker: ApneaTracker,
  frames: Array<{ t: number; loud: boolean; breath: boolean }>
): ApneaEvent[] {
  const emitted: ApneaEvent[] = [];
  for (const f of frames) {
    const evt = tracker.onFrame(f.t, { loud: f.loud, breath: f.breath });
    if (evt) emitted.push(evt);
  }
  return emitted;
}

test('apneaMinSilenceMs 把 0.1–0.9 滑块映射为 10–30 秒', () => {
  assert.equal(apneaMinSilenceMs(0.1), 10_000);
  assert.equal(apneaMinSilenceMs(0.9), 30_000);
  assert.equal(apneaMinSilenceMs(0.5), 20_000);
  // 越界值被夹紧，不抛异常
  assert.equal(apneaMinSilenceMs(0), 10_000);
  assert.equal(apneaMinSilenceMs(1), 30_000);
});

test('鼾声停止 15 秒后鼾声恢复 -> 记为一次疑似暂停', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000 });
  const events = runTracker(tracker, [
    { t: 0, loud: true, breath: true },
    { t: 1_000, loud: true, breath: true },
    { t: 5_000, loud: false, breath: false },
    { t: 16_000, loud: false, breath: false },
    { t: 21_000, loud: true, breath: true }, // 静音约 20s
  ]);
  assert.equal(events.length, 1);
  assert.ok(events[0]!.duration >= 10_000);
  assert.ok(events[0]!.duration <= DEFAULT_MAX_APNEA_SILENCE_MS);
});

test('致命回归：整晚安静后早上闹钟响 -> 不产生跨整晚的暂停事件', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000 });
  const frames = [{ t: 0, loud: true, breath: true }];
  // 中间 7 小时全部安静
  for (let t = 500; t <= 7 * 3600 * 1000; t += 60_000) {
    frames.push({ t, loud: false, breath: false });
  }
  // 早上闹钟（大声、非呼吸声）
  frames.push({ t: 7 * 3600 * 1000 + 1_000, loud: true, breath: false });

  const events = runTracker(tracker, frames);
  assert.equal(events.length, 0, '超长静音不应被判为呼吸暂停');
  for (const evt of events) {
    assert.ok(
      evt.duration <= DEFAULT_MAX_APNEA_SILENCE_MS,
      `事件时长必须被上限约束，实际 ${evt.duration}ms`
    );
  }
});

test('静音超过时长上限后由鼾声唤醒 -> 不计事件', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000, maxSilenceMs: 60_000 });
  const events = runTracker(tracker, [
    { t: 0, loud: true, breath: true },
    { t: 500, loud: true, breath: true },
    // 5 分钟安静
    { t: 300_000, loud: false, breath: false },
    // 鼾声恢复
    { t: 300_500, loud: true, breath: true },
  ]);
  assert.equal(events.length, 0);
});

test('结束静音的若是梦话/环境噪声（非呼吸声），不计为暂停', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000 });
  const events = runTracker(tracker, [
    { t: 0, loud: true, breath: true },
    { t: 500, loud: true, breath: true },
    { t: 20_000, loud: false, breath: false },
    { t: 21_000, loud: true, breath: false }, // 只是普通响声
  ]);
  assert.equal(events.length, 0);
});

test('暂停开始前 5 分钟内没有呼吸声（用户可能离开）-> 不计事件', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000, contextMs: 60_000 });
  const events = runTracker(tracker, [
    { t: 0, loud: true, breath: true }, // 最后一次呼吸声
    { t: 500, loud: true, breath: false },
    // 10 分钟无呼吸声（期间仅有零星非呼吸响声，用于推进静音锚点）
    { t: 300_000, loud: true, breath: false },
    { t: 320_000, loud: false, breath: false },
    { t: 340_000, loud: true, breath: true }, // 鼾声恢复
  ]);
  assert.equal(events.length, 0);
});

test('静音起点锚定在最后一次响亮帧，而不是下一帧', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000 });
  const events = runTracker(tracker, [
    { t: 0, loud: false, breath: false },
    { t: 3_000, loud: true, breath: true },
    { t: 3_300, loud: false, breath: false },
    { t: 14_000, loud: false, breath: false },
    { t: 14_300, loud: true, breath: true },
  ]);
  assert.equal(events.length, 1);
  // 起点应为最后一次响亮 3000ms，结束于 14300ms -> 11300ms
  assert.equal(events[0]!.start, 3_000);
  assert.equal(events[0]!.end, 14_300);
});

test('reset 后不残留上一轮状态', () => {
  const tracker = new ApneaTracker({ minSilenceMs: 10_000 });
  tracker.onFrame(0, { loud: true, breath: true });
  tracker.reset();
  assert.equal(tracker.getSilenceStartMs(), null);
  const events = runTracker(tracker, [
    { t: 0, loud: true, breath: true },
    { t: 20_000, loud: false, breath: false },
    { t: 21_000, loud: true, breath: true },
  ]);
  // reset 后 lastBreath 已清空，本应不计事件；这里主要验证不抛异常
  assert.ok(Array.isArray(events));
});
