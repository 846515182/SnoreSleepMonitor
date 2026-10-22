import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIP_PAD_BEFORE_MS,
  CLIP_PAD_AFTER_MS,
  clipFinished,
  clipStartMs,
  clipWindow,
  nextClipIndex,
  planSnoreAudio,
  selectSnoreClips,
} from '../clips';
import type { SoundEvent } from '../../types';

const snore = (start: number, end: number): SoundEvent => ({
  start,
  end,
  duration: end - start,
  type: 'snore',
});

const grind = (start: number, end: number): SoundEvent => ({
  start,
  end,
  duration: end - start,
  type: 'grind',
});

test('selectSnoreClips 只保留鼾声并按开始时间升序', () => {
  const a = snore(5000, 5500);
  const b = snore(1000, 1500);
  const g = grind(2000, 2500);
  const t: SoundEvent = { start: 300, end: 400, duration: 100, type: 'talk' };
  const ap: SoundEvent = { start: 800, end: 3000, duration: 2200, type: 'apnea' };
  const out = selectSnoreClips([a, g, b, t, ap]);
  assert.equal(out.length, 2);
  assert.equal(out[0], b, '应按 start 升序');
  assert.equal(out[1], a);
  // 与原数组共享引用：UI 的事件高亮靠对象 identity 匹配
  assert.equal(out[0], b);
});

test('selectSnoreClips 空输入 / 全非鼾声返回空数组', () => {
  assert.deepEqual(selectSnoreClips([]), []);
  assert.deepEqual(selectSnoreClips([grind(0, 100), { start: 1, end: 2, duration: 1, type: 'apnea' }]), []);
});

test('clipWindow：前后留白且起点不小于 0', () => {
  const w = clipWindow(snore(1000, 1800));
  assert.equal(w.start, 1000 - CLIP_PAD_BEFORE_MS);
  assert.equal(w.end, 1800 + CLIP_PAD_AFTER_MS);
  // 事件贴着会话开头时起点钳到 0
  const w2 = clipWindow(snore(100, 600));
  assert.equal(w2.start, 0);
});

test('clipWindow：已知音频总长时终点钳制在总长内', () => {
  const w = clipWindow(snore(1000, 1800), 1500);
  assert.equal(w.end, 1500, '终点不应超过音频总长');
  const w2 = clipWindow(snore(1000, 1800), 99999);
  assert.equal(w2.end, 1800 + CLIP_PAD_AFTER_MS);
  assert.equal(w2.end, 1800 + CLIP_PAD_AFTER_MS);
});

test('clipWindow：脏数据/钳制后的退化窗口兜底为起点后 1 秒', () => {
  // end 被钳到 start 之前（音频总长比起点还短的极端情况）
  const w = clipWindow(snore(5000, 6000), 100);
  assert.equal(w.start, 5000 - CLIP_PAD_BEFORE_MS);
  assert.equal(w.end, w.start + 1000, '退化窗口至少 1 秒');
  // end < start 的倒置脏数据（end + 留白 仍小于 start - 留白时触发兜底）
  const w2 = clipWindow(snore(2000, 500));
  assert.ok(w2.end > w2.start, '倒置事件也必须得到可播放窗口');
  assert.equal(w2.start, 2000 - CLIP_PAD_BEFORE_MS);
  assert.equal(w2.end - w2.start, 1000);
});

test('clipFinished：到达终点才算完成（边界含等于）', () => {
  const evt = snore(1000, 1800);
  const end = 1800 + CLIP_PAD_AFTER_MS;
  assert.equal(clipFinished(evt, end - 1), false);
  assert.equal(clipFinished(evt, end), true);
  assert.equal(clipFinished(evt, end + 500), true);
  assert.equal(clipFinished(evt, 0), false);
});

test('nextClipIndex：推进与播完语义', () => {
  const clips = [snore(1000, 1800), snore(5000, 5600), snore(9000, 9400)];
  const firstEnd = 1800 + CLIP_PAD_AFTER_MS;
  assert.equal(nextClipIndex(clips, 0, firstEnd - 10), 0, '未到终点留在当前段');
  assert.equal(nextClipIndex(clips, 0, firstEnd), 1, '到终点推进到下一段');
  assert.equal(nextClipIndex(clips, 2, 9400 + CLIP_PAD_AFTER_MS), 3, '最后一段播完返回 clips.length');
  assert.equal(nextClipIndex(clips, 3, 0), 3, '越界输入直接视为播完');
  assert.equal(nextClipIndex(clips, -1, 0), 3, '非法索引视为播完');
  assert.equal(nextClipIndex([], 0, 0), 0, '空列表视为播完');
});

test('nextClipIndex 遵守音频总长钳制', () => {
  const clips = [snore(1000, 1800)];
  // 音频只有 1400ms：窗口终点被钳到 1400，位置到 1400 即完成
  assert.equal(nextClipIndex(clips, 0, 1399, 1400), 0);
  assert.equal(nextClipIndex(clips, 0, 1400, 1400), 1);
});

test('clipStartMs 与 clipWindow.start 一致', () => {
  const evt = snore(2000, 2600);
  assert.equal(clipStartMs(evt), clipWindow(evt).start);
  assert.equal(clipStartMs(evt, 50), clipWindow(evt, 50).start);
});

test('planSnoreAudio：两段相隔很远的鼾声各裁一段，位置映射对得上', () => {
  const events: SoundEvent[] = [
    snore(10_000, 14_000),
    { ...snore(60_000, 62_000), type: 'talk' },
    snore(100_000, 103_000),
  ];
  const plan = planSnoreAudio(events);
  assert.equal(plan.ranges.length, 2, '中间的梦话不该被裁进来');
  // 第一段：10000-300 .. 14000+700
  assert.equal(plan.ranges[0].start, 10_000 - CLIP_PAD_BEFORE_MS);
  assert.equal(plan.ranges[0].end, 14_000 + CLIP_PAD_AFTER_MS);
  const len0 = plan.ranges[0].end - plan.ranges[0].start;
  // 第二段在新文件里的起点 = 第一段长度 + 事件相对段首的偏移
  const expectStart = len0 + (100_000 - (100_000 - CLIP_PAD_BEFORE_MS));
  assert.equal(plan.offsets[2], expectStart);
  assert.equal(plan.offsets[1], -1, '梦话没有音频');
  assert.equal(plan.totalMs, len0 + (103_000 + CLIP_PAD_AFTER_MS - (100_000 - CLIP_PAD_BEFORE_MS)));
});

test('planSnoreAudio：挨得很近的鼾声合并成一段，避免夹一堆静音', () => {
  const events: SoundEvent[] = [snore(1_000, 2_000), snore(2_300, 3_500)];
  const plan = planSnoreAudio(events);
  assert.equal(plan.ranges.length, 1);
  assert.equal(plan.ranges[0].start, 1_000 - CLIP_PAD_BEFORE_MS);
  assert.equal(plan.ranges[0].end, 3_500 + CLIP_PAD_AFTER_MS);
  // 第二段仍然能定位到合并段里的正确位置
  assert.equal(plan.offsets[1], 2_300 - plan.ranges[0].start);
});

test('planSnoreAudio：超过总时长上限就截断，不会裁出几百 MB', () => {
  const events: SoundEvent[] = [];
  for (let i = 0; i < 100; i++) {
    const s = i * 60_000;
    events.push(snore(s, s + 20_000));
  }
  const plan = planSnoreAudio(events, 5 * 60_000);
  assert.ok(plan.totalMs <= 5 * 60_000, '总时长必须在上限内');
  assert.ok(plan.ranges.length < 100, '超上限后的片段应被丢弃');
});

test('根本没有鼾声 -> 空计划，调用方不该去裁剪', () => {
  const plan = planSnoreAudio([{ ...snore(1_000, 2_000), type: 'grind' }]);
  assert.equal(plan.ranges.length, 0);
  assert.equal(plan.totalMs, 0);
});

test('clipWindow：已有 playStart 时按裁剪文件里的位置算，不再额外加留白', () => {
  const evt: SoundEvent = { ...snore(50_000, 54_000), playStart: 300, playEnd: 4_300 };
  const w = clipWindow(evt, 10_000);
  assert.equal(w.start, 300);
  assert.equal(w.end, 4_300);
  assert.equal(clipStartMs(evt), 300);
});