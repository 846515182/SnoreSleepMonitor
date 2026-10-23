import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFrame,
  DEFAULT_GRIND_CONFIDENCE,
  DEFAULT_SNORE_CONFIDENCE,
  DEFAULT_TALK_CONFIDENCE,
  SNORE_MIN_DB,
} from '../frame';
import type { Thresholds } from '../frame';

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

test('异常呼吸音只用于收口暂停，不单独计事件', () => {
  const flags = classifyFrame(
    { topClass: 'apnea', confidences: { apnea: 0.5, noise: 0.2 }, amplitudeDb: -45 },
    TH
  );
  assert.equal(flags.apneaSound, true);
  assert.equal(flags.breath, true);
  assert.equal(flags.loud, false, '喘息本身不该被记成鼾声/梦话事件');
});

test('风扇、翻身、安静呼吸都不产生事件', () => {
  for (const f of [
    quiet,
    { topClass: 'noise', confidences: { noise: 0.9, snoring: 0.12 }, amplitudeDb: -40 },
    { topClass: 'breathing', confidences: { breathing: 0.7, snoring: 0.2 }, amplitudeDb: -48 },
  ]) {
    const flags = classifyFrame(f, TH);
    assert.equal(flags.loud, false);
    assert.equal(flags.snore, false);
    assert.equal(flags.grind, false);
    assert.equal(flags.talk, false);
  }
});
