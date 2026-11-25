import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFinalEvent,
  classifyIntensity,
  percentile,
  MIN_GRIND_MS,
  MAX_GRIND_MS,
  MIN_SNORE_MS,
  MIN_TALK_MS,
  MIN_TURN_MS,
  MAX_TURN_MS,
  MAX_NOISE_MS,
} from '../events';
import type { EpisodeStats } from '../events';

/** 一段「像真打鼾」的统计量：响—停 5 个回合，音量起伏 12dB */
const snoreShape: EpisodeStats = { modulationDb: 12, bursts: 5 };

test('classifyIntensity 按置信度分三档', () => {
  assert.equal(classifyIntensity(0.8), 'severe');
  assert.equal(classifyIntensity(0.6), 'moderate');
  assert.equal(classifyIntensity(0.2), 'mild');
  assert.equal(classifyIntensity(0.75), 'severe');
  assert.equal(classifyIntensity(0.55), 'moderate');
});

test('percentile：中位数与边界', () => {
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([3, 1, 2], 0), 1);
  assert.equal(percentile([3, 1, 2], 1), 3);
  assert.equal(percentile([], 0.5), 0);
});

test('打鼾：>= 4 帧、占比 >= 0.6、>= 5 秒、有呼吸包络', () => {
  const evt = classifyFinalEvent(20_000, { snore: 20, grind: 2, talk: 1, total: 25 }, 0.8, snoreShape);
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.intensity, 'severe');
});

test('长于 45 秒的稳态噪声（风扇/空调）：不记成打鼾，兜底记成环境噪音', () => {
  const steady: EpisodeStats = { modulationDb: 1.5, bursts: 1 };
  const evt = classifyFinalEvent(60_000, { snore: 60, grind: 0, talk: 0, total: 60 }, 0.8, steady);
  assert.equal(evt?.type, 'noise');
});

test('假装打呼噜：10 秒几乎不变的连续鼾声（0.78）要记到', () => {
  const steadyShort: EpisodeStats = { modulationDb: 0.8, bursts: 1 };
  const evt = classifyFinalEvent(10_000, { snore: 10, grind: 0, talk: 0, total: 10 }, 0.78, steadyShort);
  assert.equal(evt?.type, 'snore');
  assert.equal(evt?.intensity, 'severe');
});

test('同样的连续声音只有 0.70 置信度 -> 不记成鼾声，兜底记成噪音', () => {
  const steadyShort: EpisodeStats = { modulationDb: 0.8, bursts: 1 };
  const evt = classifyFinalEvent(10_000, { snore: 10, grind: 0, talk: 0, total: 10 }, 0.7, steadyShort);
  assert.equal(evt?.type, 'noise');
});

test('打鼾帧只有 2 帧 -> 不记（单次误触最常见的形态）', () => {
  const evt = classifyFinalEvent(3000, { snore: 2, grind: 8, talk: 0, total: 10 }, 0.9, snoreShape);
  assert.notEqual(evt?.type, 'snore');
});

test('打鼾占比 0.55（旧门槛能过）-> 现在不记', () => {
  const evt = classifyFinalEvent(30_000, { snore: 55, grind: 45, talk: 0, total: 100 }, 0.9, snoreShape);
  assert.notEqual(evt?.type, 'snore');
});


test('一口气到底的连续鼾：45 秒以内且置信度 >= 0.75 才认', () => {
  const oneBurst: EpisodeStats = { modulationDb: 8, bursts: 1 };
  assert.equal(
    classifyFinalEvent(11_000, { snore: 11, grind: 0, talk: 0, total: 11 }, 0.7, oneBurst)?.type,
    'noise',
    '0.70 不足以定案为鼾声，但声音本身要留下来'
  );
  assert.equal(
    classifyFinalEvent(11_000, { snore: 11, grind: 0, talk: 0, total: 11 }, 0.8, oneBurst)?.type,
    'snore',
    '11 秒、0.80 的连续鼾声要认'
  );
  assert.equal(
    classifyFinalEvent(60_000, { snore: 60, grind: 0, talk: 0, total: 60 }, 0.9, oneBurst)?.type,
    'noise',
    '超过 45 秒的稳态声音不能靠置信度硬闯成鼾声，但会记成环境噪音'
  );
});

test('打鼾时长不足 -> 不记成鼾声，兜底记成噪音', () => {
  const evt = classifyFinalEvent(MIN_SNORE_MS - 1, { snore: 9, grind: 0, talk: 1, total: 10 }, 0.3, snoreShape);
  assert.equal(evt?.type, 'noise');
});

test('梦话：至少 2 帧、占比 >= 0.5（不再要求 1.5 秒）', () => {
  // 2 帧相邻 = 975ms：真实梦话常常只有一两句，现在要能记到
  assert.equal(
    classifyFinalEvent(975, { snore: 0, grind: 0, talk: 2, total: 2 }, 0, snoreShape)?.type,
    'talk'
  );
  assert.equal(
    classifyFinalEvent(2000, { snore: 0, grind: 0, talk: 8, total: 10 }, 0, snoreShape)?.type,
    'talk'
  );
  // 单帧（时长 0）：环境人声、咳嗽只响一帧，仍然不记
  assert.equal(classifyFinalEvent(0, { snore: 0, grind: 0, talk: 1, total: 1 }, 0, snoreShape), null);
  // 帧数够但占比只有 0.4：不记成梦话，但声音要兜底记成噪音
  assert.equal(
    classifyFinalEvent(3000, { snore: 0, grind: 0, talk: 4, total: 10 }, 0, snoreShape)?.type,
    'noise'
  );
});

test('短于 1 秒的声音低于统一记录门槛 -> 不记', () => {
  const evt = classifyFinalEvent(MIN_TALK_MS - 1, { snore: 0, grind: 0, talk: 10, total: 10 }, 0, snoreShape);
  assert.equal(evt, null, '不足 900ms 的声音连噪音兜底也不记，避免点击声刷屏');
});

test('磨牙：2 帧起记，3/5/10 帧不再被 1.5 秒上限丢掉', () => {
  const shape = (frames: number) =>
    classifyFinalEvent(
      (frames - 1) * 975,
      { snore: 0, grind: frames, talk: 0, turn: 0, total: frames },
      0,
      snoreShape
    )?.type;

  assert.equal(shape(2), 'grind', '2 帧（975ms）是现实里最短的一次磨牙，要记到');
  assert.equal(shape(3), 'grind', '3 帧（1950ms）以前会被 1500ms 上限丢掉，现在必须记到');
  assert.equal(shape(5), 'grind');
  assert.equal(shape(10), 'grind', '连磨 10 秒是真实磨牙，必须记到');

  // 单帧摩擦不记
  assert.equal(classifyFinalEvent(0, { snore: 0, grind: 1, talk: 0, turn: 0, total: 1 }, 0, snoreShape), null);
  // 占比不足（和鼾声混在一起）：不记成磨牙，兜底记成噪音
  assert.equal(
    classifyFinalEvent(6000, { snore: 0, grind: 3, talk: 0, turn: 0, total: 10 }, 0, snoreShape)?.type,
    'noise'
  );
  // 超过单条上限（更像是持续摩擦）：同样兜底成噪音
  assert.equal(
    classifyFinalEvent(MAX_GRIND_MS + 1, { snore: 0, grind: 50, talk: 0, turn: 0, total: 50 }, 0, snoreShape)?.type,
    'noise'
  );
  assert.ok(MIN_GRIND_MS >= 0);
});

test('翻身：2 帧起记、占比 >= 0.5，且单声闷响 / 持续摩擦都不记', () => {
  assert.equal(
    classifyFinalEvent(4000, { snore: 0, grind: 0, talk: 0, turn: 3, total: 4 }, 0, snoreShape)?.type,
    'turn'
  );
  // 单帧闷响（门响、东西落地）时长 0，不记
  assert.equal(
    classifyFinalEvent(0, { snore: 0, grind: 0, talk: 0, turn: 1, total: 1 }, 0, snoreShape),
    null
  );
  // 帧数够但占比 0.4：不记成翻身，兜底记成噪音
  assert.equal(
    classifyFinalEvent(4000, { snore: 0, grind: 0, talk: 0, turn: 2, total: 5 }, 0, snoreShape)?.type,
    'noise'
  );
  // 超过 2 分钟的"摩擦"（空调摆风、床垫共振）不记成翻身，兜底成噪音
  assert.equal(
    classifyFinalEvent(MAX_TURN_MS + 1, { snore: 0, grind: 0, talk: 0, turn: 30, total: 30 }, 0, snoreShape)?.type,
    'noise'
  );
  assert.ok(MIN_TURN_MS >= 0);
});

test('所有类型都不满足 -> 兜底记成环境噪音（不再整段丢弃）', () => {
  const evt = classifyFinalEvent(5_000, { snore: 1, grind: 1, talk: 1, total: 10 }, 0.9, snoreShape);
  assert.equal(evt?.type, 'noise');
});

test('环境噪音：2 帧起记，单段不超过 1 小时', () => {
  assert.equal(
    classifyFinalEvent(975, { snore: 0, grind: 0, talk: 0, noise: 2, total: 2 }, 0, snoreShape)?.type,
    'noise'
  );
  // 单帧点击/爆音不记
  assert.equal(
    classifyFinalEvent(0, { snore: 0, grind: 0, talk: 0, noise: 1, total: 1 }, 0, snoreShape),
    null
  );
  // 噪音只占 40% 也照样记录：兜底规则保证可听声音不丢
  assert.equal(
    classifyFinalEvent(4000, { snore: 0, grind: 0, talk: 0, noise: 4, total: 10 }, 0, snoreShape)?.type,
    'noise'
  );
  // 超过 1 小时：状态机会切段，分类层兜底丢弃
  assert.equal(
    classifyFinalEvent(MAX_NOISE_MS + 1, { snore: 0, grind: 0, talk: 0, noise: 3000, total: 3000 }, 0, snoreShape),
    null
  );
});

test('噪音帧不会稀释鼾声/翻身的占比判定', () => {
  // 10 帧鼾声 + 10 帧风扇底噪：分母排除噪音后鼾声占比仍是 1
  assert.equal(
    classifyFinalEvent(10_000, { snore: 10, grind: 0, talk: 0, noise: 10, total: 20 }, 0.7, {
      modulationDb: 12,
      bursts: 2,
    })?.type,
    'snore'
  );
  // 翻身优先级高于噪音
  assert.equal(
    classifyFinalEvent(4000, { snore: 0, grind: 0, talk: 0, turn: 2, noise: 2, total: 4 }, 0, snoreShape)?.type,
    'turn'
  );
});

test('空帧集合不抛异常', () => {
  assert.equal(
    classifyFinalEvent(1_000, { snore: 0, grind: 0, talk: 0, total: 0 }, 0.5, snoreShape),
    null
  );
});
