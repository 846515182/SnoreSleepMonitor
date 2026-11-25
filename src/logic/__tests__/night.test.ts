/**
 * 整晚「模拟真人」回归：按 YAMNet 的真实节奏（0.975 秒一帧）喂入
 * 打鼾 / 轻声打鼾 / 梦话 / 呼吸暂停 / 远处电视 / 稳定噪声 / 翻身摩擦 / 单帧误触，
 * 跑的是线上同一套 classifyFrame + ApneaTracker + SoundEventDetector。
 *
 * 目的不是测函数返回值，而是测「一整晚下来用户会看到什么」：事件数、时长、误报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFrame,
  DEFAULT_GRIND_CONFIDENCE,
  DEFAULT_SNORE_CONFIDENCE,
  DEFAULT_TALK_CONFIDENCE,
} from '../frame';
import type { FrameInput, Thresholds } from '../frame';
import { SoundEventDetector } from '../detector';
import { ApneaTracker } from '../apnea';
import { summarizeSession } from '../session';
import { clipWindow, planEventAudio } from '../clips';
import type { ApneaEvent } from '../apnea';
import type { SoundEvent } from '../../types';

/** YAMNet 推理窗口 0.975 秒 */
const FRAME_MS = 975;

const TH: Thresholds = {
  snore: DEFAULT_SNORE_CONFIDENCE,
  grind: DEFAULT_GRIND_CONFIDENCE,
  talk: DEFAULT_TALK_CONFIDENCE,
};

type Scene =
  | 'quiet'
  | 'snore'
  | 'softSnore'
  | 'talk'
  | 'apneaSilence'
  | 'farSnore'
  | 'straySnore'
  | 'grind'
  | 'fan'
  | 'steadyFan'
  | 'noisySnore'
  | 'continuousSnore'
  | 'lowConfSnore'
  | 'fakeSnore'
  | 'snoreLoose'
  | 'turn'
  | 'turnThump'
  | 'bedCreak'
  | 'talkShort'
  | 'grindLong'
  | 'cough';

/**
 * 单帧内容。
 * - snore：4 帧一个呼吸周期，2 帧鼾声 + 2 帧换气（真人打鼾就是这样一段一段的）
 * - steadyFan：风扇被 YAMNet 判成 snoring，且音量稳定 —— 最典型的假鼾声
 */
function frameAt(scene: Scene, i: number): FrameInput {
  switch (scene) {
    case 'snore':
      return i % 4 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.72, noise: 0.1 }, amplitudeDb: -35 }
        : { topClass: 'noise', confidences: { noise: 0.7, snoring: 0.15 }, amplitudeDb: -58 };
    case 'softSnore':
      return i % 4 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.58, noise: 0.2 }, amplitudeDb: -46 }
        : { topClass: 'noise', confidences: { noise: 0.7, snoring: 0.15 }, amplitudeDb: -64 };
    case 'talk':
      return i % 4 < 3
        ? { topClass: 'talking', confidences: { talking: 0.68, noise: 0.2 }, amplitudeDb: -42 }
        : { topClass: 'noise', confidences: { noise: 0.6 }, amplitudeDb: -58 };
    case 'apneaSilence':
      // 呼吸暂停：几乎无声（比安静呼吸还低 20dB 以上）
      return { topClass: 'noise', confidences: { noise: 0.4 }, amplitudeDb: -82 };
    case 'farSnore':
      return { topClass: 'snoring', confidences: { snoring: 0.58, noise: 0.3 }, amplitudeDb: -55 };
    case 'straySnore':
      return { topClass: 'snoring', confidences: { snoring: 0.62, noise: 0.2 }, amplitudeDb: -38 };
    case 'grind':
      return { topClass: 'grinding', confidences: { grinding: 0.6, snoring: 0.1 }, amplitudeDb: -45 };
    case 'steadyFan':
      // 风扇：YAMNet 给出 0.62 的 snoring，但音量一点起伏都没有
      return { topClass: 'snoring', confidences: { snoring: 0.62, noise: 0.3 }, amplitudeDb: -40 };
    case 'noisySnore':
      // 房间里一直有 -40dB 的风扇底噪，真人鼾声 -35dB：起伏只剩 5dB，但仍然是呼吸节奏
      return i % 4 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.7, noise: 0.2 }, amplitudeDb: -35 }
        : { topClass: 'noise', confidences: { noise: 0.85, snoring: 0.1 }, amplitudeDb: -40 };
    case 'continuousSnore':
      // 没有明显停顿的长鼾，但每个呼吸仍有约 5dB 起伏
      return {
        topClass: 'snoring',
        confidences: { snoring: 0.78, noise: 0.1 },
        amplitudeDb: i % 2 === 0 ? -34 : -39,
      };
    case 'lowConfSnore':
      return i % 4 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.4, noise: 0.3 }, amplitudeDb: -38 }
        : { topClass: 'noise', confidences: { noise: 0.7 }, amplitudeDb: -55 };
    case 'fakeSnore':
      // 对着手机假装打呼噜：一直响、音量几乎不变、置信度 0.80
      return { topClass: 'snoring', confidences: { snoring: 0.8, noise: 0.1 }, amplitudeDb: -36 };
    case 'snoreLoose':
      // 假装打鼾的人换气更久：响 2 帧、停 4 帧（约 3.9 秒）
      return i % 6 < 2
        ? { topClass: 'snoring', confidences: { snoring: 0.72, noise: 0.1 }, amplitudeDb: -34 }
        : { topClass: 'noise', confidences: { noise: 0.7 }, amplitudeDb: -58 };
    case 'turn':
      // 翻身：床架吱呀 + 被褥摩擦。响 2 帧、轻 1 帧，一次动作约 3 秒
      return i % 3 < 2
        ? { topClass: 'turn', confidences: { turn: 0.6, noise: 0.25 }, amplitudeDb: -42 }
        : { topClass: 'noise', confidences: { noise: 0.6, turn: 0.2 }, amplitudeDb: -57 };
    case 'turnThump':
      // 只响一声的闷响：门响、东西落地、只翻了一半 —— 单帧，不该成事件
      return { topClass: 'turn', confidences: { turn: 0.72, noise: 0.2 }, amplitudeDb: -38 };
    case 'bedCreak':
      // 床架轻微吱呀：-58dB，比翻身音量门槛（-55dB）还轻，属于远处环境摩擦
      return { topClass: 'turn', confidences: { turn: 0.55, noise: 0.3 }, amplitudeDb: -58 };
    case 'talkShort':
      // 梦话只嘟囔一句：2 帧带声音，第 3 帧就停了
      return i < 2
        ? { topClass: 'talking', confidences: { talking: 0.66, noise: 0.2 }, amplitudeDb: -44 }
        : { topClass: 'noise', confidences: { noise: 0.6 }, amplitudeDb: -58 };
    case 'grindLong':
      // 持续磨牙：每一帧都在磨，带轻微起伏（真实磨牙一磨就是十几秒）
      return {
        topClass: 'grinding',
        confidences: { grinding: 0.62, snoring: 0.1 },
        amplitudeDb: i % 2 === 0 ? -44 : -48,
      };
    case 'cough':
      // 咳嗽：YAMNet 原始类别为 Cough，但聚合后不属于鼾声/梦话/磨牙/翻身
      return i % 3 === 0
        ? { topClass: 'noise', confidences: { noise: 0.8 }, amplitudeDb: -40, yamnetClass: 'Cough' }
        : { topClass: 'noise', confidences: { noise: 0.55 }, amplitudeDb: -56 };
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
function runNight(frames: Frame[], minSilenceMs = 15_000, th: Thresholds = TH) {
  const detector = new SoundEventDetector();
  const apnea = new ApneaTracker({ minSilenceMs });
  const events: SoundEvent[] = [];
  const apneas: ApneaEvent[] = [];

  for (const f of frames) {
    const input = frameAt(f.scene, f.index);
    const flags = classifyFrame(input, th);
    const ap = apnea.onFrame(f.t, {
      loud: flags.loud || flags.apneaSound,
      breath: flags.breath,
    });
    if (ap) {
      apneas.push(ap);
      // App 里暂停也是事件表里的一条（type='apnea'），这里保持一致
      events.push({ start: ap.start, end: ap.end, duration: ap.duration, type: 'apnea' });
    }
    const evt = detector.push(f.t, flags, input.confidences.snoring ?? 0, input.amplitudeDb);
    if (evt) events.push(evt);
  }
  const tail = detector.flush();
  if (tail) events.push(tail);

  return { events, apneas, endTime: frames.length ? frames[frames.length - 1].t + FRAME_MS : 0 };
}

test('模拟一夜：打鼾 3 段 / 梦话 1 段 / 暂停 1 次 / 电视不计，风扇声记成噪音', () => {
  const frames = buildNight([
    ['quiet', 60],
    ['snore', 40], // 鼾声 1
    ['quiet', 30],
    ['talk', 10], // 梦话 1
    ['quiet', 8],
    ['snore', 20], // 鼾声 2
    ['apneaSilence', 15], // 暂停（15 秒无声）
    ['snore', 20], // 鼾声 3，同时收口这次暂停
    ['quiet', 60],
    ['farSnore', 40], // 远处电视：-55dB，不该记成打鼾
    ['quiet', 20],
    ['straySnore', 1], // 单帧误触
    ['quiet', 70],
    ['steadyFan', 60], // 风扇被判成 snoring、音量稳定：假鼾声的典型形态
    ['quiet', 20],
    ['grind', 2], // 磨牙 2 帧
    ['quiet', 30],
    ['fan', 40],
  ]);

  const { events, apneas, endTime } = runNight(frames);
  const byType = (type: SoundEvent['type']) => events.filter((e) => e.type === type);

  assert.equal(byType('snore').length, 3, '每段打鼾应只记 1 条，而不是每个呼吸周期一条');
  assert.equal(byType('talk').length, 1);
  assert.equal(byType('grind').length, 1);
  assert.equal(byType('noise').length, 2, '稳态风扇与 -40dB 风扇声应各记一条环境噪音');
  assert.equal(apneas.length, 1, '15 秒无声且前后都有鼾声，应记一次疑似暂停');

  const snoreSeconds = byType('snore').reduce((sum, e) => sum + e.duration, 0) / 1000;
  assert.ok(snoreSeconds >= 70 && snoreSeconds <= 90, `鼾声总时长应约 78 秒，实际 ${snoreSeconds.toFixed(1)}`);

  for (const evt of events) {
    assert.ok(evt.duration < 60_000, `不应出现横跨数分钟的假事件：${evt.type} ${evt.duration}ms`);
    assert.ok(evt.end >= evt.start);
  }

  const summary = summarizeSession({ startTime: 0, endTime, events });
  assert.equal(summary.snoreCount, 3);
  assert.equal(summary.talkCount, 1);
  assert.equal(summary.apneaCount, 1);
});

test('轻声打鼾（-46dB、置信度 0.58）仍然能记到', () => {
  const { events } = runNight(buildNight([['softSnore', 30]]));
  assert.equal(events.filter((e) => e.type === 'snore').length, 1);
});

test('稳态噪声（风扇被判成 snoring、音量不变）不记成打鼾，但逐段记为环境噪音', () => {
  const { events, apneas } = runNight(
    buildNight([
      ['steadyFan', 600],
      ['quiet', 600],
      ['steadyFan', 600],
    ])
  );
  assert.equal(events.filter((e) => e.type === 'snore').length, 0, '没有呼吸包络的稳定声音不能记成打鼾');
  assert.ok(events.filter((e) => e.type === 'noise').length >= 2, '风扇声要作为环境噪音记录下来');
  assert.equal(apneas.length, 0);
});

test('模拟应用被冻结：断帧 10 分钟不能并成一条长事件', () => {
  const a = buildNight([['snore', 20]]);
  const gap = 10 * 60 * 1000;
  const b = buildNight([['snore', 20]]).map((f) => ({ ...f, t: f.t + a[a.length - 1].t + FRAME_MS + gap }));

  const { events } = runNight([...a, ...b]);
  assert.equal(events.length, 2, '断帧前后应是两条独立事件');
  for (const evt of events) {
    assert.ok(evt.duration < 30_000, `事件时长 ${evt.duration}ms 明显被断帧撑大了`);
  }
});

test('暂停判定：6 秒不算，15 秒算，90 秒（超上限）不算', () => {
  const scenario = (silence: number) =>
    runNight(
      buildNight([
        ['snore', 20],
        ['apneaSilence', silence],
        ['snore', 20],
      ])
    ).apneas;

  assert.equal(scenario(6).length, 0);
  assert.equal(scenario(15).length, 1);
  assert.equal(scenario(90).length, 0, '超过 60 秒的安静是“没人/没录音”，不是呼吸暂停');
});

test('纯安静 + 风扇一整晚：不误报打鼾，风扇声全部记成噪音', () => {
  const { events, apneas } = runNight(
    buildNight([
      ['quiet', 600],
      ['fan', 600],
      ['quiet', 600],
    ])
  );
  assert.equal(events.filter((e) => e.type === 'snore').length, 0);
  assert.ok(events.filter((e) => e.type === 'noise').length >= 1);
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
  assert.ok(totalMinutes >= 40 && totalMinutes <= 55, `鼾声总时长应约 48 分钟，实际 ${totalMinutes.toFixed(1)}`);
});

test('嘈杂房间：-40dB 风扇底噪下的鼾声仍能记到（起伏被压缩到 5dB）', () => {
  const { events } = runNight(buildNight([['noisySnore', 30]]));
  assert.equal(events.filter((e) => e.type === 'snore').length, 1);
});

test('连续长鼾（没有换气停顿）20 秒仍然记 1 条', () => {
  const { events } = runNight(buildNight([['continuousSnore', 20]]));
  assert.equal(events.filter((e) => e.type === 'snore').length, 1);
});

test('鼾声阈值滑块双向生效：调低能收到 0.40 的轻声鼾，调高会滤掉 0.72 的鼾声', () => {
  const frames = buildNight([['snore', 30]]);
  const low = runNight(frames, 15_000, { ...TH, snore: 0.35 });
  assert.equal(low.events.filter((e) => e.type === 'snore').length, 1, '阈值 0.35 应能收到 0.72 的鼾声');

  const high = runNight(frames, 15_000, { ...TH, snore: 0.8 });
  assert.equal(high.events.filter((e) => e.type === 'snore').length, 0, '阈值 0.8 应滤掉 0.72 的鼾声');

  const lowConf = buildNight([['lowConfSnore', 30]]);
  assert.equal(
    runNight(lowConf, 15_000, { ...TH, snore: 0.35 }).events.filter((e) => e.type === 'snore').length,
    1,
    '阈值调低后 0.40 的鼾声要能记到（不能被写死的平均置信度门槛挡掉）'
  );
  assert.equal(
    runNight(lowConf).events.filter((e) => e.type === 'snore').length,
    0,
    '默认 0.55 时 0.40 不该记'
  );
});

test('整晚跑完后裁剪：鼾声/梦话/磨牙都有音频，暂停明确没有', () => {
  const { events } = runNight(
    buildNight([
      ['quiet', 20],
      ['snore', 30],
      ['quiet', 10],
      ['talk', 8],
      ['quiet', 10],
      ['grind', 2],
      ['quiet', 10],
      ['apneaSilence', 15],
      ['snore', 20],
      ['quiet', 10],
    ])
  );
  const plan = planEventAudio(events);
  assert.ok(plan.ranges.length >= 3, '至少应有鼾声/梦话/磨牙三段音频');
  assert.ok(plan.totalMs > 30_000);

  const audioEvents = events.filter((e) => e.type !== 'apnea');
  assert.ok(audioEvents.length >= 3);

  // 与 App.tsx 停止后的映射保持一致
  const cut = events.map((ev, i) =>
    plan.offsets[i] >= 0
      ? { ...ev, playStart: plan.offsets[i], playEnd: plan.offsets[i] + (ev.end - ev.start) }
      : ev
  );

  cut.forEach((ev) => {
    if (ev.type === 'apnea') {
      assert.equal(ev.playStart, undefined, '暂停是无声段，不应有音频');
      return;
    }
    assert.ok(typeof ev.playStart === 'number' && ev.playStart >= 0, `${ev.type} 应该有可播放起点`);
    assert.ok((ev.playEnd ?? 0) > (ev.playStart ?? 0), `${ev.type} 的播放区间必须非空`);
    const w = clipWindow(ev, plan.totalMs);
    assert.ok(w.end > w.start);
    assert.ok(w.end <= plan.totalMs + 1);
  });
});

test('假装打呼噜：8 秒连续不断、音量不变的鼾声要记到', () => {
  const { events } = runNight(buildNight([['fakeSnore', 8]]));
  assert.equal(events.filter((e) => e.type === 'snore').length, 1);
});

test('假装打呼噜时每次换气停 4 秒：不会被拆成碎片', () => {
  const { events } = runNight(buildNight([['snoreLoose', 24]]));
  const snores = events.filter((e) => e.type === 'snore');
  assert.equal(snores.length, 1, '4 秒换气停顿要跨过去，不能拆成好几条');
  assert.ok((snores[0]?.duration ?? 0) >= 10_000);
});
test('真人一夜：打鼾 / 梦话 / 磨牙 / 翻身 / 暂停全部记到，单声闷响与轻床响不误报', () => {
  const frames = buildNight([
    ['quiet', 50],
    ['turn', 6], // 23:12 翻身
    ['quiet', 40],
    ['snore', 60], // 打鼾
    ['apneaSilence', 20], // 暂停 20 秒
    ['snore', 30], // 鼾声收口
    ['quiet', 60],
    ['talkShort', 4], // 02:05 梦话一句（旧逻辑要 1.5 秒才记，这句是 0.975 秒）
    ['quiet', 40],
    ['grindLong', 8], // 04:20 磨牙 8 帧（旧逻辑被 1.5 秒上限整段丢掉）
    ['quiet', 50],
    ['turnThump', 1], // 一声闷响：不该记
    ['quiet', 50],
    ['bedCreak', 6], // 床架轻响 -58dB：不该记
    ['quiet', 40],
    ['turn', 6], // 05:40 再翻身
    ['quiet', 40],
  ]);

  const { events, apneas, endTime } = runNight(frames);
  const byType = (type: SoundEvent['type']) => events.filter((e) => e.type === type);

  assert.equal(byType('snore').length, 2, '两段打鼾');
  assert.equal(byType('turn').length, 2, '两次翻身都要记到');
  assert.equal(byType('talk').length, 1, '短梦话也要记到');
  assert.equal(byType('grind').length, 1, '8 帧的持续磨牙要记到一条，而不是丢掉');
  assert.equal(apneas.length, 1);

  // 单声闷响、轻床响不能变成事件
  assert.equal(events.filter((e) => e.type === 'turn').length, 2, '仅两次真实翻身');

  const summary = summarizeSession({ startTime: 0, endTime, events });
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.talkCount, 1);
  assert.equal(summary.grindCount, 1);
  assert.equal(summary.snoreCount, 2);
  assert.ok(summary.totalTurnSeconds >= 6, `翻身总时长应有 6 秒以上，实际 ${summary.totalTurnSeconds}`);

  // 翻身属于正常行为：把它剔掉，质量分必须一分不变
  const withoutTurn = summarizeSession({
    startTime: 0,
    endTime,
    events: events.filter((e) => e.type !== 'turn'),
  });
  assert.equal(withoutTurn.qualityScore, summary.qualityScore, '翻身不能影响睡眠质量评分');

  // 翻身也要有音频可回放（用户要能自己确认"这一声是什么"）
  const plan = planEventAudio(events);
  const turnEvents = byType('turn');
  assert.equal(plan.ranges.length >= 1, true);
  for (const ev of turnEvents) {
    const idx = events.indexOf(ev);
    assert.ok(plan.offsets[idx] >= 0, '翻身事件应能对到音频片段');
  }
});

test('整晚只有翻身：不会冒出鼾声/梦话/暂停', () => {
  const { events, apneas } = runNight(
    buildNight([
      ['quiet', 60],
      ['turn', 8],
      ['quiet', 120],
      ['turn', 8],
      ['quiet', 60],
    ])
  );
  assert.equal(events.filter((e) => e.type !== 'turn').length, 0, '翻身不能被判成别的类型');
  assert.equal(events.filter((e) => e.type === 'turn').length, 2);
  assert.equal(apneas.length, 0);
});

test('梦话停顿 7 秒后再翻身：各自成条，不互相吞并', () => {
  const { events } = runNight(
    buildNight([
      ['talk', 6],
      ['quiet', 7],
      ['turn', 4],
      ['quiet', 20],
    ])
  );
  const types = events.map((e) => e.type);
  assert.deepEqual(types.sort(), ['talk', 'turn'], `梦话与翻身应各一条，实际 ${types}`);
});

test('梦话与翻身同时发生（边说边动）：并成一条，按占比归到主类别', () => {
  // 现实里"嘟囔着翻身"就是一整段连续的声音，硬拆成两条反而更糟；
    // 这里钉死的是"归到占比更大的那一类"，而不是两边各记一半。
  const { events } = runNight(
    buildNight([
      ['talk', 6],
      ['turn', 4],
      ['quiet', 20],
    ])
  );
  assert.equal(events.length, 1, `连续声音只应是一条事件，实际 ${events.map((e) => e.type)}`);
  assert.equal(events[0]?.type, 'talk', '梦话帧更多，应归到梦话');
});

test('咳嗽等未归类声音逐条记录，并用文字标出具体声音', () => {
  const { events } = runNight(buildNight([['cough', 5]]));
  const noises = events.filter((e) => e.type === 'noise');
  assert.equal(noises.length, 1, `应只记一条咳嗽噪音，实际 ${events.map((e) => e.type + ':' + e.soundLabel)}`);
  assert.equal(noises[0]?.soundLabel, '咳嗽声');
});
