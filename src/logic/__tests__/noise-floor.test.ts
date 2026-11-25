import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptiveThresholds,
  CALIBRATION_SAMPLES,
  DEFAULT_FLOOR_DB,
  FLOOR_WINDOW_FRAMES,
  MAX_FLOOR_DB,
  MIN_FLOOR_DB,
  NoiseFloorTracker,
  type NoiseFloorSnapshot,
} from '../noiseFloor';

function feed(tracker: NoiseFloorTracker, db: number, count: number): NoiseFloorSnapshot {
  let snap = tracker.push(db);
  for (let i = 1; i < count; i += 1) snap = tracker.push(db);
  return snap;
}

test('校准前不启用自适应，积累足够样本后给出安静房间底噪', () => {
  const tracker = new NoiseFloorTracker();
  const early = feed(tracker, -56, 5);
  assert.equal(early.calibrated, false, '开场几个样本不足以代表整晚环境');

  const ready = feed(tracker, -56, CALIBRATION_SAMPLES);
  assert.equal(ready.calibrated, true);
  assert.equal(Math.round(ready.floorDb), -56);
  assert.equal(ready.snrDb, 0, '等于底噪的帧信噪比为 0');
});

test('响的鼾声不会把底噪一路抬高（约 50% 占空比）', () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, -56, 40);

  let snap = tracker.push(-56);
  for (let i = 0; i < 300; i += 1) {
    // 响 1 帧 -30dB、换气 1 帧 -56dB：真实打鼾的节奏
    snap = tracker.push(i % 2 === 0 ? -30 : -56);
  }
  assert.ok(snap.floorDb <= -50, `底噪应仍接近安静值，实际 ${snap.floorDb}`);
});

test('空调房底噪更高，自适应阈值随之抬高', () => {
  const quiet = new NoiseFloorTracker();
  feed(quiet, -70, 40);
  const noisy = new NoiseFloorTracker();
  feed(noisy, -44, 40);

  const q = adaptiveThresholds(quiet.currentFloorDb);
  const n = adaptiveThresholds(noisy.currentFloorDb);
  assert.ok(n.snoreMinDb > q.snoreMinDb, '吵的房间必须要求更响的鼾声');
  assert.ok(n.noiseMinDb > q.noiseMinDb, '吵的房间不能把底噪全记成噪音');
  assert.ok(n.turnMinDb > q.turnMinDb);

  // 典型 -56dB 房间应返回原来的固定阈值，保证既有行为不漂移
  const typical = adaptiveThresholds(-56);
  assert.equal(typical.snoreMinDb, -48);
  assert.equal(typical.noiseMinDb, -52);
});

test('底噪哨兵值 -100 不参与统计', () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, -100, 100);
  assert.equal(tracker.calibrated, false);
  assert.equal(tracker.currentFloorDb, DEFAULT_FLOOR_DB);
});

test('滑动窗口会忘掉旧环境，换房间后重新适应', () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, -70, FLOOR_WINDOW_FRAMES);
  assert.ok(tracker.currentFloorDb <= -69);

  feed(tracker, -40, FLOOR_WINDOW_FRAMES + 50);
  assert.ok(tracker.currentFloorDb >= -41, `实际 ${tracker.currentFloorDb}`);
});

test('底噪夹取在合法范围内', () => {
  const loud = new NoiseFloorTracker();
  feed(loud, 20, 40);
  assert.equal(loud.currentFloorDb, MAX_FLOOR_DB);

  const low = new NoiseFloorTracker();
  feed(low, -90, 40);
  assert.equal(low.currentFloorDb, MIN_FLOOR_DB);
});
