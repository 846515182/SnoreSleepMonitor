import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundEventDetector, MAX_FRAME_GAP_MS } from '../detector';
import { GRACE_MS } from '../events';

const snore = { snore: true, grind: false, talk: false };
const quiet = { snore: false, grind: false, talk: false };
const FRAME = 975;

function feed(det: SoundEventDetector, from: number, count: number, frame = snore) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const evt = det.push(from + i * FRAME, frame, 0.7);
    if (evt) out.push(evt);
  }
  return out;
}

test('单帧误触：flush 也不会生成事件', () => {
  const det = new SoundEventDetector();
  feed(det, 0, 1);
  assert.equal(det.flush(), null);
});

test('两帧不够（3 帧门槛），三帧才算', () => {
  const det = new SoundEventDetector();
  feed(det, 0, 2);
  assert.equal(det.flush(), null);

  const det2 = new SoundEventDetector();
  feed(det2, 0, 3);
  const evt = det2.flush();
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.duration, FRAME * 2);
});

test('呼吸间隔（2 帧静音）不会把一次打鼾拆成两条', () => {
  const det = new SoundEventDetector();
  const out: unknown[] = [];
  // 2 帧鼾声 + 2 帧换气，重复 5 个周期
  for (let cycle = 0; cycle < 5; cycle += 1) {
    out.push(...feed(det, cycle * 4 * FRAME, 2));
    out.push(...feed(det, (cycle * 4 + 2) * FRAME, 2, quiet));
  }
  out.push(...feed(det, 5 * 4 * FRAME, Math.ceil(GRACE_MS / FRAME) + 1, quiet));
  assert.equal(out.length, 1);
  assert.equal((out[0] as { type: string }).type, 'snore');
});

test('断帧超过上限时先落定上一段，不会把空白并进来', () => {
  const det = new SoundEventDetector();
  feed(det, 0, 3);
  const late = feed(det, MAX_FRAME_GAP_MS + FRAME * 3, 3);
  assert.equal(late.length, 1, '新的一段开始时应把旧的一段交出来');
  assert.ok(late[0].duration < MAX_FRAME_GAP_MS);
  assert.equal(det.flush()?.type, 'snore');
});
