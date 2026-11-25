import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfidenceSmoother,
  SMOOTH_ATTACK,
  SMOOTH_RELEASE,
  topEventClass,
} from '../confidenceSmoother';

test('新事件第一帧直接吸附，不会被平滑吞掉', () => {
  const smoother = new ConfidenceSmoother();
  const out = smoother.push({ talking: 0.66 });
  assert.equal(out.talking, 0.66, '上一帧为 0 时应直接采用本帧值');
});

test('置信度上升按快攻系数平滑', () => {
  const smoother = new ConfidenceSmoother();
  smoother.push({ snoring: 0.5 });
  const out = smoother.push({ snoring: 1 });
  assert.equal(out.snoring, 0.5 + 0.5 * SMOOTH_ATTACK);
});

test('下降比上升慢，短暂掉帧不会立刻归零', () => {
  const smoother = new ConfidenceSmoother();
  smoother.push({ snoring: 0.8 });
  const out = smoother.push({});
  assert.equal(out.snoring, 0.8 * (1 - SMOOTH_RELEASE));
  assert.ok(out.snoring > 0.5, '单帧缺失后仍应保持较高置信度');
});

test('连续静音会衰减到可忽略', () => {
  const smoother = new ConfidenceSmoother();
  smoother.push({ snoring: 0.9 });
  let out = smoother.snapshot;
  for (let i = 0; i < 10; i += 1) out = smoother.push({});
  assert.ok(out.snoring < 0.06, `实际 ${out.snoring}`);
});

test('topEventClass 取最高事件类别，纯噪音帧回退 noise', () => {
  assert.equal(topEventClass({ snoring: 0.6, talking: 0.4 }), 'snoring');
  assert.equal(topEventClass({ snoring: 0.4, talking: 0.6 }), 'talking');
  assert.equal(topEventClass({ grinding: 0.7, snoring: 0.2 }), 'grinding');
  assert.equal(topEventClass({}), 'noise');
  assert.equal(topEventClass({ noise: 1 }), 'noise', 'noise 不参与事件类别竞争');
});
