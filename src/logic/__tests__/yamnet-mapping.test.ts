import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * YAMNet 类别映射：原生 Kotlin 里写死的音频事件类 index，必须和 assets 里的
 * yamnet_class_map.csv 对得上。
 *
 * 这类"魔数"最容易出错，而且错了不会崩、只会静默地把翻身记成磨牙、把梦话记成噪声，
 * 所以这里把 CSV 当唯一事实来源逐条比对。
 */
const root = path.join(__dirname, '..', '..', '..');
const plugin = fs.readFileSync(path.join(root, 'plugins', 'withAudioMeter.js'), 'utf8');
const lines = fs
  .readFileSync(path.join(root, 'assets', 'yamnet', 'yamnet_class_map.csv'), 'utf8')
  .trim()
  .split(/\r?\n/);

/** CSV 第一行是表头，类别 index 从 0 开始 */
function labelOf(index: number): string {
  const line = lines[index + 1];
  assert.ok(line, `CSV 里没有第 ${index} 类`);
  return line.split(',').slice(2).join(',').replace(/"/g, '').trim();
}

function indicesOf(constName: string): number[] {
  const match = plugin.match(new RegExp(`val ${constName} = listOf\\(([^)]*)\\)`));
  assert.ok(match, `原生模块里没有 ${constName}`);
  return match![1]
    .split(',')
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

const SNORING = indicesOf('SNORING_INDICES');
const APNEA = indicesOf('APNEA_INDICES');
const TALKING = indicesOf('TALKING_INDICES');
const GRINDING = indicesOf('GRINDING_INDICES');
const TURN = indicesOf('TURN_INDICES');

test('索引都落在 YAMNet 的 521 类范围内', () => {
  for (const idx of [...SNORING, ...APNEA, ...TALKING, ...GRINDING, ...TURN]) {
    assert.ok(idx >= 0 && idx < 521, `索引 ${idx} 越界`);
  }
});

test('鼾声就是 Snoring，呼吸暂停是喘息类', () => {
  assert.deepEqual(
    SNORING.map(labelOf),
    ['Snoring']
  );
  const apneaLabels = APNEA.map(labelOf);
  assert.ok(apneaLabels.includes('Wheeze'), `呼吸暂停类别里应有 Wheeze，实际 ${apneaLabels}`);
  assert.ok(apneaLabels.includes('Gasp'));
});

test('梦话覆盖「含混的嘟囔」：Speech / Whispering / Babbling', () => {
  const labels = TALKING.map(labelOf);
  assert.ok(labels.includes('Speech'));
  assert.ok(labels.includes('Whispering'), '梦话经常被 YAMNet 判成气声');
  assert.ok(labels.includes('Babbling'), '梦话常常是含混的咕哝，必须有 Babbling');
});

test('磨牙只用摩擦类代理，不碰床架声', () => {
  const labels = GRINDING.map(labelOf);
  for (const expected of ['Chewing', 'Biting', 'Scratch', 'Rub']) {
    assert.ok(
      labels.some((l) => l.includes(expected)),
      `磨牙类别应包含 ${expected}，实际 ${labels}`
    );
  }
  // 床架吱呀属于翻身，混进磨牙会让每次翻身都被记成磨牙
  assert.ok(!labels.some((l) => l.includes('Squeak')), '磨牙不能再包含 Squeak');
  assert.ok(!labels.some((l) => l.includes('Creak')), '磨牙不能再包含 Creak');
});

test('翻身覆盖被褥摩擦、身体落床的闷响、床架吱呀', () => {
  const labels = TURN.map(labelOf);
  assert.ok(labels.some((l) => l.includes('Rustle')), `翻身应有被褥摩擦类，实际 ${labels}`);
  assert.ok(labels.some((l) => l.includes('Thump')), '翻身应有身体落床的闷响');
  assert.ok(labels.some((l) => l.includes('Creak') || l.includes('Squeak')), '翻身应有床架吱呀');
});

test('磨牙与翻身不共用类别：一次翻身不能同时被两套判据抢走', () => {
  const overlap = GRINDING.filter((i) => TURN.includes(i));
  assert.deepEqual(overlap, [], `磨牙与翻身共用了索引 ${overlap.map(labelOf)}`);
});

test('原生聚合里有 turn，且 noise 把 turn 一起减掉', () => {
  assert.ok(plugin.includes('"turn" to turn'), 'aggregateScores 没输出 turn');
  assert.ok(
    plugin.includes('1.0 - snoring - apnea - talking - grinding - turn'),
    'noise 没有把 turn 扣掉，各分数加起来会超过 1'
  );
});
