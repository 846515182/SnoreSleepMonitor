import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFrame,
  DEFAULT_GRIND_CONFIDENCE,
  DEFAULT_SNORE_CONFIDENCE,
  DEFAULT_TALK_CONFIDENCE,
  SNORE_MIN_DB,
  TURN_MIN_DB,
} from '../frame';
import type { FrameInput, Thresholds } from '../frame';

const TH: Thresholds = {
  snore: DEFAULT_SNORE_CONFIDENCE,
  grind: DEFAULT_GRIND_CONFIDENCE,
  talk: DEFAULT_TALK_CONFIDENCE,
};

const quiet = { topClass: 'noise', confidences: { noise: 0.8, snoring: 0.1 }, amplitudeDb: -55 };

test('鼾声三门槛：top 类别 + 置信度 + 音量', () => {
  assert.equal(
    classifyFrame(
      { topClass: 'snoring', confidences: { snoring: 0.6, noise: 0.2 }, amplitudeDb: -40 },
      TH
    ).snore,
    true
  );
  // 置信度不够
  assert.equal(
    classifyFrame(
      { topClass: 'snoring', confidences: { snoring: 0.3, noise: 0.5 }, amplitudeDb: -40 },
      TH
    ).snore,
    false
  );
  // 音量太轻：远处电视/雨声
  assert.equal(
    classifyFrame(
      { topClass: 'snoring', confidences: { snoring: 0.9, noise: 0.05 }, amplitudeDb: SNORE_MIN_DB - 5 },
      TH
    ).snore,
    false
  );
  // top 类别不是 snoring
  assert.equal(
    classifyFrame(
      { topClass: 'noise', confidences: { snoring: 0.6, noise: 0.7 }, amplitudeDb: -40 },
      TH
    ).snore,
    false
  );
});

test('磨牙阈值设置真的生效（此前是死参数）', () => {
  const frame = { topClass: 'grinding', confidences: { grinding: 0.45, noise: 0.4 }, amplitudeDb: -45 };
  assert.equal(classifyFrame(frame, TH).grind, true, '0.45 >= 默认 0.4 应命中');
  assert.equal(classifyFrame(frame, { ...TH, grind: 0.55 }).grind, false, '调到 0.55 后应不再命中');

  // 不是 grinding 类、置信度也不够高：不能靠“比另外两类大”混进来
  assert.equal(
    classifyFrame(
      { topClass: 'noise', confidences: { grinding: 0.3, snoring: 0.1, talking: 0.1 }, amplitudeDb: -40 },
      TH
    ).grind,
    false
  );
  // 明确是 grinding 且置信度高：即使不是 top 也算
  assert.equal(
    classifyFrame(
      { topClass: 'noise', confidences: { grinding: 0.6, snoring: 0.1, talking: 0.1 }, amplitudeDb: -40 },
      TH
    ).grind,
    true
  );
});

test('梦话要求 top 为 talking 且过阈值', () => {
  assert.equal(
    classifyFrame(
      { topClass: 'talking', confidences: { talking: 0.6, noise: 0.2 }, amplitudeDb: -42 },
      TH
    ).talk,
    true
  );
  assert.equal(
    classifyFrame(
      { topClass: 'talking', confidences: { talking: 0.4, noise: 0.4 }, amplitudeDb: -42 },
      TH
    ).talk,
    false
  );
  assert.equal(
    classifyFrame(
      { topClass: 'noise', confidences: { talking: 0.7, noise: 0.8 }, amplitudeDb: -42 },
      TH
    ).talk,
    false
  );
});

test('异常呼吸音用于收口暂停，同时作为可听声音记录', () => {
  const flags = classifyFrame(
    { topClass: 'apnea', confidences: { apnea: 0.5, noise: 0.2 }, amplitudeDb: -45 },
    TH
  );
  assert.equal(flags.apneaSound, true);
  assert.equal(flags.breath, true);
  assert.equal(flags.noise, true, '喘息/喘鸣是真实存在的声音，应进入噪音记录');
  assert.equal(flags.loud, true);
});

test('所有可听声音都记录：风扇/呼吸声归为噪音，安静帧不记录', () => {
  const quietFlags = classifyFrame(quiet, TH);
  assert.equal(quietFlags.loud, false, '低于 -52dB 的房间底噪不应刷屏');
  assert.equal(quietFlags.noise, false);

  for (const f of [
    { topClass: 'noise', confidences: { noise: 0.9, snoring: 0.12 }, amplitudeDb: -40 },
    { topClass: 'breathing', confidences: { breathing: 0.7, snoring: 0.2 }, amplitudeDb: -48 },
  ] as FrameInput[]) {
    const flags = classifyFrame(f, TH);
    assert.equal(flags.noise, true, '不属于四类事件的 audible 声音要记录为环境噪音');
    assert.equal(flags.loud, true);
    assert.equal(flags.snore, false);
    assert.equal(flags.grind, false);
    assert.equal(flags.talk, false);
    assert.equal(flags.turn, false);
  }

  // 翻身：床架吱呀 + 被褥摩擦，top 类别为 turn
  const turn = classifyFrame(
    { topClass: 'turn', confidences: { turn: 0.55, noise: 0.3 }, amplitudeDb: -42 },
    TH
  );
  assert.equal(turn.turn, true);
  assert.equal(turn.noise, false, '翻身已有专属类别，不再重复记成噪音');
  assert.equal(turn.snore, false, '翻身不能被记成打鼾');
  assert.equal(turn.talk, false);
  assert.equal(turn.grind, false);
  assert.equal(turn.loud, true, '翻身要参与事件合并与静音锚定');

  // 置信度不够：房间里一点轻微摩擦
  assert.equal(
    classifyFrame({ topClass: 'turn', confidences: { turn: 0.3, noise: 0.6 }, amplitudeDb: -42 }, TH).turn,
    false
  );
  // 音量太轻：远处环境里的塑料摩擦声，不能算翻身
  assert.equal(
    classifyFrame(
      { topClass: 'turn', confidences: { turn: 0.8, noise: 0.1 }, amplitudeDb: TURN_MIN_DB - 5 },
      TH
    ).turn,
    false
  );
  // top 类别不是 turn：别的类别帧里夹带摩擦分，不能抢走事件
  assert.equal(
    classifyFrame({ topClass: 'snoring', confidences: { snoring: 0.7, turn: 0.5 }, amplitudeDb: -40 }, TH)
      .turn,
    false
  );
});

test('自适应音量阈值可覆盖固定值（安静房间放宽、空调房收紧）', () => {
  const softSnore = {
    topClass: 'snoring',
    confidences: { snoring: 0.9, noise: 0.05 },
    amplitudeDb: -52,
  };
  assert.equal(classifyFrame(softSnore, TH).snore, false, '默认 -48 下限挡住 -52dB');
  assert.equal(
    classifyFrame(softSnore, { ...TH, snoreMinDb: -58 }).snore,
    true,
    '安静房间底噪低，应能记到更轻的鼾声'
  );
  assert.equal(
    classifyFrame(softSnore, { ...TH, snoreMinDb: -40 }).snore,
    false,
    '开空调的房间抬高门槛后不再命中'
  );

  const quietNoise = { topClass: 'noise', confidences: { noise: 0.9 }, amplitudeDb: -55 };
  assert.equal(classifyFrame(quietNoise, TH).noise, false, '默认 -52 下限挡住 -55dB');
  assert.equal(
    classifyFrame(quietNoise, { ...TH, noiseMinDb: -58 }).noise,
    true,
    '安静房间能记录到更轻的环境声'
  );
});

test('噪音帧用 YAMNet 原始类别生成中文文字标签', () => {
  const cough = classifyFrame(
    { topClass: 'noise', confidences: { noise: 0.9 }, amplitudeDb: -40, yamnetClass: 'Cough' },
    TH
  );
  assert.equal(cough.noise, true);
  assert.equal(cough.soundLabel, '咳嗽声');

  const dog = classifyFrame(
    { topClass: 'noise', confidences: { noise: 0.9 }, amplitudeDb: -40, yamnetClass: 'Bark' },
    TH
  );
  assert.equal(dog.soundLabel, '狗叫声');

  // 未收录的类别不硬翻，界面回退为「环境噪音」
  const unknown = classifyFrame(
    { topClass: 'noise', confidences: { noise: 0.9 }, amplitudeDb: -40, yamnetClass: 'Zzz' },
    TH
  );
  assert.equal(unknown.soundLabel, undefined);

  // 音量不够时不产生噪音帧，标签也不应出现
  const quietCough = classifyFrame(
    { topClass: 'noise', confidences: { noise: 0.9 }, amplitudeDb: -55, yamnetClass: 'Cough' },
    TH
  );
  assert.equal(quietCough.noise, false);
  assert.equal(quietCough.soundLabel, undefined);
});
