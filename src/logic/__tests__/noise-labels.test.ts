/**
 * 噪音中文标签映射回归：
 * 直接拿真实的 yamnet_class_map.csv 来跑，确保「咳嗽/喷嚏/狗叫/开关门/交通…」
 * 这些常见类别不会因为规则顺序或整词匹配写错而落到错误的标签上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { describeYamnetClass } from '../noiseLabels';

function loadYamnetDisplayNames(): string[] {
  const csv = fs.readFileSync(path.resolve(__dirname, '../../../assets/yamnet/yamnet_class_map.csv'), 'utf8');
  return csv
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      // index,mid,display_name —— display_name 里可能带逗号
      const parts = line.split(',');
      return parts
        .slice(2)
        .join(',')
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim();
    });
}

const names = loadYamnetDisplayNames();

test('常见声音类别都能翻成中文', () => {
  const cases: Array<[string, string]> = [
    ['Cough', '咳嗽声'],
    ['Sneeze', '喷嚏声'],
    ['Sniff', '吸鼻声'],
    ['Snoring', '打鼾声'],
    ['Speech', '说话声'],
    ['Laughter', '笑声'],
    ['Baby cry, infant cry', '婴儿哭声'],
    ['Bark', '狗叫声'],
    ['Meow', '猫叫声'],
    ['Cricket', '虫鸣声'],
    ['Doorbell', '门铃声'],
    ['Telephone bell ringing', '电话铃声'],
    ['Alarm clock', '闹钟声'],
    ['Siren', '警笛声'],
    ['Vacuum cleaner', '家电声'],
    ['Mechanical fan', '风扇/空调声'],
    ['Air conditioning', '风扇/空调声'],
    ['Typing', '键盘声'],
    ['Car alarm', '警报声'],
    ['Car passing by', '交通声'],
    ['Train', '列车声'],
    ['Thunder', '雷声'],
    ['Rain', '雨声'],
    ['Dishes', '餐具/烹饪声'],
    ['Shatter', '玻璃/碰撞声'],
    ['Footsteps', '脚步声'],
    ['Tick-tock', '钟表声'],
    ['White noise', '环境底噪'],
    ['Inside, small room', '室内环境声'],
    ['Outside, urban or manmade', '室外环境声'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(describeYamnetClass(raw), expected, `${raw} 应映射为 ${expected}`);
  }
});

test('整词匹配不能把 Train 当成 Rain、Carnatic music 当成交通', () => {
  assert.equal(describeYamnetClass('Train'), '列车声');
  assert.equal(describeYamnetClass('Train whistle'), '列车声');
  assert.equal(describeYamnetClass('Carnatic music'), '音乐声');
  assert.equal(describeYamnetClass('Car'), '交通声');
  assert.equal(describeYamnetClass('Busy signal'), '电话铃声');
  assert.equal(describeYamnetClass('Boat, Water vehicle'), '交通声');
});

test('未知/空类别返回 undefined，由界面回退为「环境噪音」', () => {
  assert.equal(describeYamnetClass(undefined), undefined);
  assert.equal(describeYamnetClass(''), undefined);
  assert.equal(describeYamnetClass('Zzz'), undefined);
});

test('真实类别表里绝大多数常见声音都有中文标签', () => {
  const labels = new Set(names.map((name) => describeYamnetClass(name)).filter(Boolean));
  for (const label of [
    '咳嗽声',
    '喷嚏声',
    '说话声',
    '狗叫声',
    '猫叫声',
    '开关门声',
    '电话铃声',
    '警报声',
    '交通声',
    '水声',
    '雨声',
    '风声',
    '脚步声',
    '音乐声',
    '室内环境声',
  ]) {
    assert.ok(labels.has(label), `真实类别表中应至少有一个类别映射到「${label}」`);
  }
});
