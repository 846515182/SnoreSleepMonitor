import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundEventDetector, MAX_FRAME_GAP_MS } from '../detector';
import { MAX_NOISE_MS } from '../events';

const snore = { snore: true, grind: false, talk: false };
const quiet = { snore: false, grind: false, talk: false };
const FRAME = 975;

const SNORE_DB = -34;
const QUIET_DB = -58;

/** 一个真人呼吸周期：2 帧鼾声 + 2 帧换气（约 3.9 秒） */
function feedCycles(det: SoundEventDetector, from: number, cycles: number) {
  const out: NonNullable<ReturnType<SoundEventDetector['push']>>[] = [];
  let t = from;
  for (let c = 0; c < cycles; c += 1) {
    for (let i = 0; i < 2; i += 1) {
      const e = det.push(t, snore, 0.7, SNORE_DB);
      if (e) out.push(e);
      t += FRAME;
    }
    for (let i = 0; i < 2; i += 1) {
      const e = det.push(t, quiet, 0.1, QUIET_DB);
      if (e) out.push(e);
      t += FRAME;
    }
  }
  return { events: out, next: t };
}

test('单帧误触：flush 也不会生成事件', () => {
  const det = new SoundEventDetector();
  det.push(0, snore, 0.7, SNORE_DB);
  assert.equal(det.flush(), null);
});

test('3 个呼吸周期（6 帧、约 8.8 秒）起记；2 个周期不够鼾声门槛，但声音要兜底记录', () => {
  const two = new SoundEventDetector();
  feedCycles(two, 0, 2);
  assert.equal(two.flush()?.type, 'noise', '2 个周期只有 3.9 秒，不够鼾声，但仍是可听声音');

  const three = new SoundEventDetector();
  feedCycles(three, 0, 3);
  assert.equal(three.flush()?.type, 'snore');
});

test('稳态噪声：连续响 57 秒、置信度 0.78，不认成打鼾，但兜底记成噪音', () => {
  const det = new SoundEventDetector();
  for (let i = 0; i < 60; i += 1) {
    const e = det.push(i * FRAME, snore, 0.78, SNORE_DB);
    assert.equal(e, null);
  }
  assert.equal(det.flush()?.type, 'noise');
});

test('呼吸间隔（2 帧静音）不会把一次打鼾拆成两条', () => {
  const det = new SoundEventDetector();
  const { events } = feedCycles(det, 0, 5);
  const tail = det.flush();
  const all = tail ? [...events, tail] : events;
  assert.equal(all.length, 1);
  assert.equal(all[0]?.type, 'snore');
});

test('断帧超过上限时先落定上一段，不会把空白并进来', () => {
  const det = new SoundEventDetector();
  feedCycles(det, 0, 4);
  const late = feedCycles(det, MAX_FRAME_GAP_MS + 60_000, 4).events;
  assert.equal(late.length, 1, '新的一段开始时应把旧的一段交出来');
  assert.ok((late[0]?.duration ?? 0) < 30_000);
  assert.equal(det.flush()?.type, 'snore');
});

test('推理失败的 -100dB 哨兵值不能撑大音量起伏', () => {
  // 2dB 起伏 + 0.70 置信度：本来就不该认
  const clean = new SoundEventDetector();
  for (let i = 0; i < 24; i += 1) {
    const on = i % 4 < 2;
    clean.push(i * FRAME, on ? snore : quiet, on ? 0.7 : 0.1, on ? -40 : -42);
  }
  assert.equal(clean.flush()?.type, 'noise');

  // 混进一个 -100dB 哨兵：如果把它算进包络，起伏会被撑到 60dB，反而通过
  const dirty = new SoundEventDetector();
  for (let i = 0; i < 24; i += 1) {
    const on = i % 4 < 2;
    dirty.push(i * FRAME, on ? snore : quiet, on ? 0.7 : 0.1, i === 6 ? -100 : on ? -40 : -42);
  }
  assert.notEqual(dirty.flush()?.type, 'snore', '哨兵值不能把稳态噪声抬成打鼾');
});

test('风扇那种 2dB 以内的微小起伏，仍然不认成打鼾', () => {
  const det = new SoundEventDetector();
  for (let i = 0; i < 40; i += 1) {
    det.push(i * FRAME, snore, 0.7, i % 2 === 0 ? -40 : -42);
  }
  assert.notEqual(det.flush()?.type, 'snore');
});

const noise = { snore: false, grind: false, talk: false, noise: true };

test('其他可听声音逐条记录为环境噪音，并保留文字标签', () => {
  const det = new SoundEventDetector();
  let event = det.push(0, { ...noise, soundLabel: '咳嗽声' }, 0, -40);
  assert.equal(event, null, '单帧还不该落定');
  event = det.push(FRAME, { ...noise, soundLabel: '咳嗽声' }, 0, -42);
  assert.equal(event, null);
  const final = det.flush();
  assert.equal(final?.type, 'noise');
  assert.equal(final?.soundLabel, '咳嗽声');
  assert.ok((final?.duration ?? 0) >= 900);
});

test('连续环境噪音被切成 1 小时一段，不会变成整晚一条', () => {
  const det = new SoundEventDetector();
  const events: NonNullable<ReturnType<SoundEventDetector['push']>>[] = [];
  const totalFrames = Math.ceil((MAX_NOISE_MS + 10_000) / FRAME);
  for (let i = 0; i < totalFrames; i += 1) {
    const e = det.push(i * FRAME, { ...noise, soundLabel: '风扇/空调声' }, 0, -40);
    if (e) events.push(e);
  }
  const tail = det.flush();
  if (tail) events.push(tail);
  assert.ok(events.length >= 2, `${totalFrames} 帧应至少切成两段，实际 ${events.length}`);
  assert.ok(events.every((e) => e.type === 'noise'));
  assert.ok(
    events.every((e) => e.duration <= MAX_NOISE_MS + FRAME),
    '单段不超过 1 小时上限'
  );
});

test('鼾声停下后尾随的风扇声不会把鼾声事件无限拉长', () => {
  const det = new SoundEventDetector();
  const { events } = feedCycles(det, 0, 3);
  let t = 3 * 4 * FRAME;
  // 之后是连续 20 帧风扇底噪（约 19.5 秒）
  for (let i = 0; i < 20; i += 1) {
    const e = det.push(t, { ...noise, soundLabel: '风扇/空调声' }, 0, -40);
    if (e) events.push(e);
    t += FRAME;
  }
  const tail = det.flush();
  const all = tail ? [...events, tail] : events;
  const snores = all.filter((e) => e.type === 'snore');
  const noises = all.filter((e) => e.type === 'noise');
  assert.equal(snores.length, 1, '鼾声应完整落下一条');
  assert.ok(snores[0]!.duration < 20_000, '鼾声不能被尾随底噪拉长');
  assert.equal(noises.length, 1, '尾随底噪应另记一条噪音');
});
