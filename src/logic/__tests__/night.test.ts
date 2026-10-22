/**
 * 整晚「模拟真人」回归：按 YAMNet 的真实节奏（0.975 秒一帧）喂入
 * 打鼾 / 梦话 / 呼吸暂停 / 远处电视 / 翻身摩擦 / 单帧误触 等场景，
 * 跑的是线上同一套 classifyFrame + ApneaTracker + SoundEventDetector。
 *
 * 目的不是测函数返回值，而是测「一整晚下来用户会看到什么」：
 * 事件数、时长、误报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFrame, DEFAULT_GRIND_CONFIDENCE, DEFAULT_SNORE_CONFIDENCE, DEFAULT_TALK_CONFIDENCE } from '../frame';
import type { FrameInput, Thresholds } from '../frame';
import { SoundEventDetector } from '../detector';
import { ApneaTracker } from '../apnea';
import { summarizeSession } from '../session';
import type { ApneaEvent } from '../apnea';
import type { SoundEvent } from '../../types';

/** YAMNet 推理窗口 0.975 秒 */
const FRAME_MS = 975;

const TH: Thresholds = {
  snore: DEFAULT_SNORE_CONFIDENCE,
  grind: DEFAULT_GRIND_CONFIDENCE,
  talk: DEFAULT_TALK_CONFIDENCE,
};

type Scene = 'quiet' | 'snore' | 'talk' | 'apneaSilence' | 'farSnore' | 'straySnore' | 'grind' | 'fan';

/**
 * 单帧内容。
 * - snore：4 帧一个呼吸周期，2 帧鼾声 + 2 帧间歇（真人打鼾就是这样一段一段的）
 * - talk：3 帧说话 + 1 帧换气
 * - farSnore：远处电视/雨声被 YAMNet 判成 snoring，但到手机只剩 -55dB
 * - straySnore：只有 1 帧的偶发误判
 */
function frameAt(scene: Scene, i: number): FrameInput {
  switch (scene) {
    case 'snore':
      return i % 4 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.72, noise: 0.1 }, amplitudeDb: -35 }
        : { topClass: 'noise', confidences: { noise: 0.7, snoring: 0.15 }, amplitudeDb: -58 };
    case 'talk':
      return i % 4 < 3
        ? { topClass: 'talking', confidences: { talking: 0.68, noise: 0.2 }, amplitudeDb: -42 }
        : { topClass: 'noise', confidences: { noise: 0.6 }, amplitudeDb: -55 };
    case 'apneaSilence':
      // 呼吸暂停：几乎无声（比安静呼吸还低 20dB 以上）
      return { topClass: 'noise', confidences: { noise: 0.4 }, amplitudeDb: -82 };
    case 'farSnore':
      return { topClass: 'snoring', confidences: { snoring: 0.58, noise: 0.3 }, amplitudeDb: -55 };
    case 'straySnore':
      return { topClass: 'snoring', confidences: { snoring: 0.62, noise: 0.2 }, amplitudeDb: -38 };
    case 'grind':
      return { topClass: 'grinding', confidences: { grinding: 0.6, snoring: 0.1 }, amplitudeDb: -45 };
    case 'fan':
      return { topClass: 'noise', confidences: { noise: 0.9, snoring: 0.12 }, amplitudeDb: -40 };
    case 'quiet':
    default:
      return { topClass: 'noise', confidences: { noise: 0.65, snoring: 0.1 }, amplitudeDb: -56 };
  }
}

interface Frame {
  t: number;
  scene: Scene;
  index: number;
}

function buildNight(script: Array<[Scene, number]>): Frame[] {
  const frames: Frame[] = [];
  let t = 0;
  for (const [scene, seconds] of script) {
    const count = Math.round((seconds * 1000) / FRAME_MS);
    for (let i = 0; i < count; i += 1) {
      frames.push({ t, scene, index: i });
      t += FRAME_MS;
    }
  }
  return frames;
}

/** 与 App.tsx 的 applyNativeResult 同序执行：分类 → 暂停 → 事件状态机 */
function runNight(frames: Frame[], minSilenceMs = 10_000) {
  const detector = new SoundEventDetector();
  const apnea = new ApneaTracker({ minSilenceMs });
  const events: SoundEvent[] = [];
  const apneas: ApneaEvent[] = [];

  for (const f of frames) {
    const input = frameAt(f.scene, f.index);
    const flags = classifyFrame(input, TH);
    const ap = apnea.onFrame(f.t, {
      loud: flags.loud || flags.apneaSound,
      breath: flags.breath,
    });
    if (ap) {
      apneas.push(ap);
      // App 里暂停也是事件表里的一条（type='apnea'），这里保持一致
      events.push({ start: ap.start, end: ap.end, duration: ap.duration, type: 'apnea' });
    }
    const evt = detector.push(f.t, flags, input.confidences.snoring ?? 0);
    if (evt) events.push(evt);
  }
  const tail = detector.flush();
  if (tail) events.push(tail);

  return { events, apneas, endTime: frames.length ? frames[frames.length - 1].t + FRAME_MS : 0 };
}

test('模拟一夜：打鼾 3 段 / 梦话 1 段 / 暂停 1 次 / 电视与单帧误判不计', () => {
  const frames = buildNight([
    ['quiet', 60],
    ['snore', 40], // 鼾声 1
    ['quiet', 30],
    ['talk', 10], // 梦话 1
    ['quiet', 8], // 短于 10 秒的停顿不算暂停
    ['snore', 20], // 鼾声 2
    ['apneaSilence', 15], // 暂停（15 秒无声）
    ['snore', 12], // 鼾声 3，同时收口这次暂停
    ['quiet', 60],
    ['farSnore', 40], // 远处电视：-55dB，不该记成打鼾
    ['quiet', 20],
    ['straySnore', 1], // 单帧误触
    ['quiet', 60],
    ['grind', 2], // 磨牙 2 帧
    ['quiet', 30],
    ['fan', 40], // 风扇：没有鼾声置信度
  ]);

  const { events, apneas, endTime } = runNight(frames);
  const byType = (type: SoundEvent['type']) => events.filter((e) => e.type === type);

  assert.equal(byType('snore').length, 3, '每段打鼾应只记 1 条，而不是每个呼吸周期一条');
  assert.equal(byType('talk').length, 1);
  assert.equal(byType('grind').length, 1);
  assert.equal(apneas.length, 1, '15 秒无声且前后都有鼾声，应记一次疑似暂停');

  // 时长要接近真实值（允许一帧的量化误差）
  const snoreSeconds = byType('snore').reduce((sum, e) => sum + e.duration, 0) / 1000;
  assert.ok(snoreSeconds >= 66 && snoreSeconds <= 76, `鼾声总时长应约 72 秒，实际 ${snoreSeconds.toFixed(1)}`);

  for (const evt of events) {
    assert.ok(evt.duration < 60_000, `不应出现横跨数分钟的假事件：${evt.type} ${evt.duration}ms`);
    assert.ok(evt.end >= evt.start);
  }

  const summary = summarizeSession({
    startTime: 0,
    endTime,
    events,
  });
  assert.equal(summary.snoreCount, 3);
  assert.equal(summary.talkCount, 1);
  assert.equal(summary.apneaCount, 1);
  assert.ok(summary.totalSnoreSeconds >= 66);
});

test('模拟应用被冻结：断帧 10 分钟不能并成一条长事件', () => {
  const a = buildNight([['snore', 6]]);
  const gap = 10 * 60 * 1000;
  const b = buildNight([['snore', 6]]).map((f) => ({ ...f, t: f.t + a[a.length - 1].t + FRAME_MS + gap }));

  const { events } = runNight([...a, ...b]);
  assert.equal(events.length, 2, '断帧前后应是两条独立事件');
  for (const evt of events) {
    assert.ok(evt.duration < 10_000, `事件时长 ${evt.duration}ms 明显被断帧撑大了`);
  }
});

test('暂停判定：6 秒不算，15 秒算，90 秒（超上限）不算', () => {
  const scenario = (silence: number) =>
    runNight(
      buildNight([
        ['snore', 20],
        ['apneaSilence', silence],
        ['snore', 10],
      ])
    ).apneas;

  assert.equal(scenario(6).length, 0);
  assert.equal(scenario(15).length, 1);
  assert.equal(scenario(90).length, 0, '超过 60 秒的安静是“没人/没录音”，不是呼吸暂停');
});

test('纯安静 + 风扇一整晚：0 事件、0 暂停', () => {
  const { events, apneas } = runNight(
    buildNight([
      ['quiet', 600],
      ['fan', 600],
      ['quiet', 600],
    ])
  );
  assert.equal(events.length, 0);
  assert.equal(apneas.length, 0);
});

test('八小时长跑：72 段打鼾全部记到，且没有跨分钟假事件', () => {
  const script: Array<[Scene, number]> = [];
  // 每 6 分钟安静 + 40 秒打鼾，共 8 小时（约 72 段）
  for (let i = 0; i < 72; i += 1) {
    script.push(['quiet', 360]);
    script.push(['snore', 40]);
  }
  script.push(['quiet', 60]);

  const frames = buildNight(script);
  const { events, apneas, endTime } = runNight(frames);

  assert.equal(events.filter((e) => e.type === 'snore').length, 72);
  assert.equal(apneas.length, 0, '每一段安静都超过 60 秒，不能算暂停');
  assert.ok(endTime >= 8 * 3600 * 1000, '应覆盖整晚 8 小时');

  const totalMinutes = events.reduce((sum, e) => sum + e.duration, 0) / 60000;
  assert.ok(totalMinutes >= 45 && totalMinutes <= 55, `鼾声总时长应约 48 分钟，实际 ${totalMinutes.toFixed(1)}`);
});
