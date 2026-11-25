#!/usr/bin/env node
/**
 * 整晚模拟：按 YAMNet 的真实节奏（0.975 秒一帧）回放一段"真人一夜"，
 * 跑线上同一套 classifyFrame + ApneaTracker + SoundEventDetector + summarizeSession，
 * 最后打印用户在 App 里会看到的那份报告。
 *
 * 用法：node scripts/simulate-night.cjs
 * （需要先 npx tsc -p tsconfig.test.json，npm test 会自动做这一步）
 */
const logic = require('../test-dist/logic/frame.js');
const { SoundEventDetector } = require('../test-dist/logic/detector.js');
const { ApneaTracker } = require('../test-dist/logic/apnea.js');
const { summarizeSession } = require('../test-dist/logic/session.js');
const { planEventAudio } = require('../test-dist/logic/clips.js');

const FRAME_MS = 975;
const TH = {
  snore: logic.DEFAULT_SNORE_CONFIDENCE,
  grind: logic.DEFAULT_GRIND_CONFIDENCE,
  talk: logic.DEFAULT_TALK_CONFIDENCE,
  turn: logic.DEFAULT_TURN_CONFIDENCE,
};

/** 每种场景的单帧内容：与 night.test.ts 的 frameAt 一致 */
function frameAt(scene, i) {
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
    case 'talkShort':
      return i < 2
        ? { topClass: 'talking', confidences: { talking: 0.66, noise: 0.2 }, amplitudeDb: -44 }
        : { topClass: 'noise', confidences: { noise: 0.6 }, amplitudeDb: -58 };
    case 'grindLong':
      return {
        topClass: 'grinding',
        confidences: { grinding: 0.62, snoring: 0.1 },
        amplitudeDb: i % 2 === 0 ? -44 : -48,
      };
    case 'cough':
      return i % 3 === 0
        ? { topClass: 'noise', confidences: { noise: 0.8 }, amplitudeDb: -40, yamnetClass: 'Cough' }
        : { topClass: 'noise', confidences: { noise: 0.55 }, amplitudeDb: -56 };
    case 'turn':
      return i % 3 < 2
        ? { topClass: 'turn', confidences: { turn: 0.6, noise: 0.25 }, amplitudeDb: -42 }
        : { topClass: 'noise', confidences: { noise: 0.6, turn: 0.2 }, amplitudeDb: -57 };
    case 'turnThump':
      return { topClass: 'turn', confidences: { turn: 0.72, noise: 0.2 }, amplitudeDb: -38 };
    case 'bedCreak':
      return { topClass: 'turn', confidences: { turn: 0.55, noise: 0.3 }, amplitudeDb: -58 };
    case 'apneaSilence':
      return { topClass: 'noise', confidences: { noise: 0.4 }, amplitudeDb: -82 };
    case 'farSnore':
      return { topClass: 'snoring', confidences: { snoring: 0.58, noise: 0.3 }, amplitudeDb: -55 };
    case 'fan':
      return { topClass: 'noise', confidences: { noise: 0.9, snoring: 0.12 }, amplitudeDb: -40, yamnetClass: 'Inside, small room' };
    case 'quiet':
    default:
      return { topClass: 'noise', confidences: { noise: 0.65, snoring: 0.1 }, amplitudeDb: -56 };
  }
}

/** 一段"真人一夜"的剧本：[场景, 秒数, 说明] */
const SCRIPT = [
  ['quiet', 900, '22:30 上床，安静入睡'],
  ['turn', 8, '22:45 翻身'],
  ['quiet', 120, ''],
  ['snore', 2400, '23:00 开始打鼾'],
  ['apneaSilence', 20, '鼾声中间断气 20 秒'],
  ['snore', 600, '鼾声把暂停收口'],
  ['quiet', 300, ''],
  ['turn', 8, '01:00 翻身'],
  ['quiet', 900, ''],
  ['talkShort', 4, '01:20 梦话一句（约 1 秒）'],
  ['quiet', 600, ''],
  ['cough', 5, '01:30 咳嗽几声（应记为环境噪音·咳嗽声）'],
  ['quiet', 1200, ''],
  ['grindLong', 10, '02:10 磨牙（约 9 秒）'],
  ['quiet', 600, ''],
  ['snore', 1800, '02:30 再打鼾'],
  ['apneaSilence', 25, '断气 25 秒'],
  ['snore', 900, '收口'],
  ['quiet', 1800, ''],
  ['turn', 8, '04:20 翻身'],
  ['quiet', 1800, ''],
  ['farSnore', 600, '客厅电视人声（-55dB，不该记）'],
  ['quiet', 600, ''],
  ['fan', 120, '04:40 空调/风扇持续噪音（应记为环境噪音）'],
  ['quiet', 600, ''],
  ['talk', 6, '05:10 梦话一段'],
  ['quiet', 1200, ''],
  ['grindLong', 12, '05:40 再磨牙'],
  ['quiet', 900, ''],
  ['turn', 6, '06:00 翻身'],
  ['quiet', 1200, ''],
  ['turnThump', 1, '东西落地一声闷响（不该记）'],
  ['quiet', 1500, ''],
  ['snore', 900, '06:40 晨间小鼾'],
  ['quiet', 1500, ''],
  ['bedCreak', 6, '床架轻微吱呀 -58dB（不该记）'],
  ['turn', 6, '07:10 起床前翻身'],
  ['quiet', 1500, '07:10 之后仍在床上安静'],
];

function buildFrames(script) {
  const frames = [];
  const windows = [];
  let t = 0;
  for (const [scene, seconds, note] of script) {
    const count = Math.round((seconds * 1000) / FRAME_MS);
    const from = t;
    for (let i = 0; i < count; i += 1) {
      frames.push({ t, scene, index: i, note });
      t += FRAME_MS;
    }
    windows.push({ scene, start: from, end: t, note });
  }
  return { frames, windows, endTime: t };
}

/** 监测从 22:30 开始，报告里的时刻用真实钟点显示 */
const CLOCK_BASE_MS = (22 * 60 + 30) * 60 * 1000;
const clock = (ms) => {
  const total = Math.floor((ms + CLOCK_BASE_MS) / 1000);
  const h = String(Math.floor(total / 3600) % 24).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};
const dur = (ms) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
};

function main() {
  const { frames, windows, endTime } = buildFrames(SCRIPT);

  const detector = new SoundEventDetector();
  const apnea = new ApneaTracker({ minSilenceMs: 15_000 });
  const events = [];
  const apneas = [];

  for (const f of frames) {
    const input = frameAt(f.scene, f.index);
    const flags = logic.classifyFrame(input, TH);
    const ap = apnea.onFrame(f.t, { loud: flags.loud || flags.apneaSound, breath: flags.breath });
    if (ap) {
      apneas.push(ap);
      events.push({ start: ap.start, end: ap.end, duration: ap.duration, type: 'apnea' });
    }
    const evt = detector.push(f.t, flags, input.confidences.snoring ?? 0, input.amplitudeDb);
    if (evt) events.push(evt);
  }
  const tail = detector.flush();
  if (tail) events.push(tail);

  const summary = summarizeSession({ startTime: 0, endTime, events });
  const plan = planEventAudio(events);

  const label = { snore: '打鼾', grind: '磨牙', talk: '梦话', apnea: '呼吸暂停', turn: '翻身', noise: '环境噪音' };
  const color = { snore: '青', grind: '黄', talk: '紫', apnea: '红', turn: '蓝', noise: '灰' };

  console.log('\n========== 模拟一夜（8 小时，逐帧回放）==========');
  console.log(`帧数 ${frames.length}  ·  时长 ${dur(endTime)}  ·  帧间隔 ${FRAME_MS}ms`);

  console.log('\n---------- 事件时间轴 ----------');
  console.log('  时刻      类型        时长');
  for (const e of events.slice().sort((a, b) => a.start - b.start)) {
    const i = events.indexOf(e);
    const audio = plan.offsets[i] >= 0 ? '（可回放）' : '（无音频）';
    const name = e.type === 'noise' && e.soundLabel ? `环境噪音·${e.soundLabel}` : label[e.type];
    console.log(
      `  ${clock(e.start)}  ${(name + ' ').padEnd(6, '　')}  ${dur(e.duration).padStart(8)}  ${audio}`
    );
  }

  console.log('\n---------- 报告统计 ----------');
  const rows = [
    ['打鼾', summary.snoreCount, summary.totalSnoreSeconds],
    ['磨牙', summary.grindCount, summary.totalGrindSeconds],
    ['梦话', summary.talkCount, summary.totalTalkSeconds],
    ['翻身', summary.turnCount, summary.totalTurnSeconds],
    ['环境噪音', summary.noiseCount, summary.totalNoiseSeconds],
    ['呼吸暂停', summary.apneaCount, summary.totalApneaSeconds],
  ];
  for (const [name, count, seconds] of rows) {
    console.log(`  ${(name + '　　').slice(0, 5)}  ${String(count).padStart(3)} 次   ${dur(seconds * 1000)}`);
  }
  console.log(`  事件总数 ${events.length}`);
  console.log(`  睡眠质量分 ${summary.qualityScore}   暂停风险 ${summary.apneaRisk}（疑似 ${(summary.apneaCount / (endTime / 3.6e6)).toFixed(2)} 次/小时）`);
  console.log(`  鼾声分级：轻 ${summary.intensityBreakdown.mild} · 中 ${summary.intensityBreakdown.moderate} · 重 ${summary.intensityBreakdown.severe}`);
  console.log(`  保留音频：${plan.ranges.length} 段，共 ${dur(plan.totalMs)}`);

  // ---------- 断言：这份"用户看到的报告"应该满足的现实预期 ----------
  const byType = (type) => events.filter((e) => e.type === type);
  const withoutTurn = summarizeSession({
    startTime: 0,
    endTime,
    events: events.filter((e) => e.type !== 'turn'),
  });
  const withoutNoise = summarizeSession({
    startTime: 0,
    endTime,
    events: events.filter((e) => e.type !== 'noise'),
  });

  /** 某个场景的时间窗里有没有冒出事件（判断误报用） */
  const eventsIn = (scene) => {
    const w = windows.find((x) => x.scene === scene);
    return events.filter((e) => e.start >= w.start && e.start < w.end);
  };

  const checks = [
    [
      '打鼾被记到（5 段：3 段连续鼾声 + 2 段被暂停切开的续鼾）',
      byType('snore').length === 5,
      `实际 ${byType('snore').length}`,
    ],
    ['磨牙被记到（2 次：9 秒与 11 秒的持续磨牙）', byType('grind').length === 2, `实际 ${byType('grind').length}`],
    ['梦话被记到（1 秒短句 + 一段 4 秒）', byType('talk').length === 2, `实际 ${byType('talk').length}`],
    ['翻身被记到（5 次）', byType('turn').length === 5, `实际 ${byType('turn').length}`],
    ['呼吸暂停被记到（2 次）', byType('apnea').length === 2, `实际 ${byType('apnea').length}`],
    [
      '客厅电视（-55dB 人声）没有误报',
      eventsIn('farSnore').length === 0,
      `该时间窗内 ${eventsIn('farSnore').length} 条`,
    ],
    [
      '东西落地的一声闷响没有变成"翻身"',
      eventsIn('turnThump').length === 0,
      `该时间窗内 ${eventsIn('turnThump').length} 条`,
    ],
    [
      '床架轻微吱呀（-58dB）没有变成"翻身"',
      eventsIn('bedCreak').length === 0,
      `该时间窗内 ${eventsIn('bedCreak').length} 条`,
    ],
    [
      '咳嗽等可听声音被逐条记录，并用文字标出',
      byType('noise').some((e) => e.soundLabel === '咳嗽声'),
      `噪音 ${byType('noise').length} 条，标签 ${JSON.stringify(byType('noise').map((e) => e.soundLabel))}`,
    ],
    [
      '空调/风扇持续噪音被记录，并标出「室内环境声」',
      eventsIn('fan').some((e) => e.type === 'noise' && e.soundLabel === '室内环境声'),
      `该时间窗内 ${eventsIn('fan').filter((e) => e.type === 'noise').length} 条噪音`,
    ],
    [
      '环境噪音不拉低睡眠质量分',
      withoutNoise.qualityScore === summary.qualityScore,
      `${withoutNoise.qualityScore} vs ${summary.qualityScore}`,
    ],
    [
      '环境噪音不占用片段音频预算',
      byType('noise').every((e) => plan.offsets[events.indexOf(e)] < 0),
      `噪音 ${byType('noise').length} 条均不裁剪音频`,
    ],
    [
      '翻身不影响睡眠质量分',
      withoutTurn.qualityScore === summary.qualityScore,
      `${withoutTurn.qualityScore} vs ${summary.qualityScore}`,
    ],
    [
      '梦话/磨牙/翻身全部有音频可回放（不会被鼾声独占预算）',
      byType('talk')
        .concat(byType('grind'), byType('turn'))
        .every((e) => plan.offsets[events.indexOf(e)] >= 0),
      '鼾声 110 分钟仍留有 45 分钟预算给稀有声事件',
    ],
    ['每条事件时长自洽', events.every((e) => e.end >= e.start), ''],
  ];

  console.log('\n---------- 断言 ----------');
  let failed = 0;
  for (const [name, ok, extra] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `（${extra}）` : ''}`);
  }
  console.log(failed === 0 ? '\n全部通过 ✅\n' : `\n${failed} 项未通过 ❌\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
