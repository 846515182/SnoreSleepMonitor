import test from 'node:test';
import assert from 'node:assert/strict';

import { QUALITY_WINDOW_MS, SignalQualityMonitor } from '../audioQuality';

function feed(
  monitor: SignalQualityMonitor,
  frames: number,
  frame: { amplitudeDb: number; peakDb?: number; clipped?: boolean; snrDb?: number }
): void {
  for (let i = 0; i < frames; i += 1) monitor.push(frame);
}

test('安静环境 + 完整帧 + 无削波 = 良好', () => {
  const monitor = new SignalQualityMonitor();
  feed(monitor, 100, { amplitudeDb: -35, peakDb: -8, snrDb: 25 });

  const quality = monitor.summary(100 * QUALITY_WINDOW_MS, -58);
  assert.ok(quality);
  assert.equal(quality.level, 'good');
  assert.equal(quality.coverage, 1);
  assert.equal(quality.issues.length, 0);
});

test('削波会降低质量并给出原因', () => {
  const monitor = new SignalQualityMonitor();
  feed(monitor, 100, { amplitudeDb: -3, peakDb: -0.1, snrDb: 30 });

  const quality = monitor.summary(100 * QUALITY_WINDOW_MS, -60);
  assert.ok(quality);
  assert.equal(quality.level, 'poor', '几乎每帧都削波应判定较差');
  assert.ok(quality.issues.some((issue) => issue.includes('削波')));
});

test('掉帧过多判定较差', () => {
  const monitor = new SignalQualityMonitor();
  feed(monitor, 30, { amplitudeDb: -40 });

  const quality = monitor.summary(100 * QUALITY_WINDOW_MS, -58);
  assert.ok(quality);
  assert.equal(quality.coverage, 0.3);
  assert.equal(quality.level, 'poor');
  assert.ok(quality.issues.some((issue) => issue.includes('音频帧')));
});

test('嘈杂底噪判定一般，并提示受影响', () => {
  const monitor = new SignalQualityMonitor();
  feed(monitor, 100, { amplitudeDb: -30, snrDb: 12 });

  const quality = monitor.summary(100 * QUALITY_WINDOW_MS, -44);
  assert.ok(quality);
  assert.equal(quality.level, 'fair');
  assert.ok(quality.issues.some((issue) => issue.includes('底噪')));
});

test('有效声音贴着底噪时判定较差', () => {
  const monitor = new SignalQualityMonitor();
  feed(monitor, 100, { amplitudeDb: -50, snrDb: 5 });

  const quality = monitor.summary(100 * QUALITY_WINDOW_MS, -58);
  assert.ok(quality);
  assert.equal(quality.level, 'poor');
  assert.ok(quality.issues.some((issue) => issue.includes('差距')));
});

test('没有帧时不出结论（避免刚启动就给出假质量）', () => {
  const monitor = new SignalQualityMonitor();
  assert.equal(monitor.summary(0, -60), undefined);
});
