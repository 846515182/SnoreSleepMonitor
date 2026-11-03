import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EVENTS_PER_SESSION,
  canStartMonitoring,
  canStopMonitoring,
  initialMonitorState,
  monitorReducer,
  shouldAcceptNativeFrame,
} from '../../state/monitorState';
import type { MonitorState } from '../../state/monitorState';
import { classifyFrame } from '../frame';
import type { SoundEvent } from '../../types';

/**
 * 监测状态机 / 帧门槛的行为测试。
 *
 * 原先这些约束靠断言 App.tsx 源码文本（`if (startInFlightRef.current) return;`、
 * `windowId <= lastWindowIdRef.current`）来守，改一行注释就可能误伤。
 * 现在它们是可执行代码：重复 start/stop 被忽略、迟到帧被丢弃、统计只累加一次。
 */

const event = (type: SoundEvent['type'], duration: number, start = 0): SoundEvent => ({
  start,
  end: start + duration,
  duration,
  type,
});

const run = (state: MonitorState, actions: Parameters<typeof monitorReducer>[1][]) =>
  actions.reduce(monitorReducer, state);

test('启动互斥：idle 才能 start，重复 start 被忽略且不改变状态', () => {
  assert.equal(canStartMonitoring('idle'), true);
  assert.equal(canStartMonitoring('starting'), false);
  assert.equal(canStartMonitoring('monitoring'), false);
  assert.equal(canStartMonitoring('stopping'), false);

  const starting = monitorReducer(initialMonitorState, { type: 'start/begin' });
  assert.equal(starting.phase, 'starting');
  // 第二次 start 返回同一个对象引用：调用方据此判定“被忽略”，不会再次拉起原生录音
  assert.equal(monitorReducer(starting, { type: 'start/begin' }), starting);
});

test('启动成功只从 starting 进入 monitoring，其它阶段收到该动作无副作用', () => {
  const starting = monitorReducer(initialMonitorState, { type: 'start/begin' });
  const monitoring = monitorReducer(starting, { type: 'start/succeeded' });
  assert.equal(monitoring.phase, 'monitoring');
  assert.equal(monitorReducer(monitoring, { type: 'start/succeeded' }), monitoring);
  assert.equal(monitorReducer(initialMonitorState, { type: 'start/succeeded' }), initialMonitorState);
});

test('启动失败回到 idle，并清空本次聚合，允许重试', () => {
  const starting = monitorReducer(initialMonitorState, { type: 'start/begin' });
  const failed = monitorReducer(starting, { type: 'start/failed' });
  assert.equal(failed.phase, 'idle');
  assert.deepEqual(failed.counts, { snore: 0, grind: 0, talk: 0, apnea: 0 });
  assert.deepEqual(failed.events, []);
});

test('停止互斥：monitoring 才能 stop，重复 stop 被忽略，不会双结算', () => {
  assert.equal(canStopMonitoring('monitoring'), true);
  assert.equal(canStopMonitoring('starting'), false);
  assert.equal(canStopMonitoring('stopping'), false);
  assert.equal(canStopMonitoring('idle'), false);

  const monitoring = run(initialMonitorState, [{ type: 'start/begin' }, { type: 'start/succeeded' }]);
  const stopping = monitorReducer(monitoring, { type: 'stop/begin' });
  assert.equal(stopping.phase, 'stopping');
  // 第二次点击“停止”被忽略：不会产生第二条会话
  assert.equal(monitorReducer(stopping, { type: 'stop/begin' }), stopping);
});

test('停止结算只执行一次：finish 后回到 idle，重复 finish 无副作用', () => {
  const stopping = run(initialMonitorState, [
    { type: 'start/begin' },
    { type: 'start/succeeded' },
    { type: 'stop/begin' },
  ]);
  const idle = monitorReducer(stopping, { type: 'stop/finish' });
  assert.equal(idle.phase, 'idle');
  assert.deepEqual(idle.events, []);
  assert.deepEqual(idle.counts, { snore: 0, grind: 0, talk: 0, apnea: 0 });
  assert.equal(monitorReducer(idle, { type: 'stop/finish' }), idle);
});

test('帧去重：同一个 windowId 只计一次，乱序与旧会话迟到帧被丢弃', () => {
  // 监测中：windowId 必须严格递增
  assert.equal(shouldAcceptNativeFrame('monitoring', 3, 2), true);
  assert.equal(shouldAcceptNativeFrame('monitoring', 2, 2), false);
  assert.equal(shouldAcceptNativeFrame('monitoring', 1, 2), false);
  // 原生 start 复位 -1，第一帧无效
  assert.equal(shouldAcceptNativeFrame('starting', -1, -1), false);
  assert.equal(shouldAcceptNativeFrame('monitoring', -1, -1), false);
  assert.equal(shouldAcceptNativeFrame('monitoring', Number.NaN, -1), false);
});

test('帧去重：idle/stopping 阶段的迟到帧不计入，避免结算后改写事件表', () => {
  assert.equal(shouldAcceptNativeFrame('idle', 10, -1), false);
  assert.equal(shouldAcceptNativeFrame('stopping', 11, 10), false);
  // starting 阶段允许（原生已拉起、还没进入 monitoring 的第一批帧）
  assert.equal(shouldAcceptNativeFrame('starting', 0, -1), true);
});

test('事件累加：计数与时长只加一次，类型分别记账', () => {
  const monitoring = run(initialMonitorState, [{ type: 'start/begin' }, { type: 'start/succeeded' }]);
  const once = run(monitoring, [
    { type: 'frame/event', event: event('snore', 5000) },
    { type: 'frame/event', event: event('apnea', 10000, 6000) },
  ]);
  assert.deepEqual(once.counts, { snore: 1, grind: 0, talk: 0, apnea: 1 });
  assert.equal(once.events.length, 2);
  assert.equal(once.totalsMs.snore, 5000);
  assert.equal(once.totalsMs.apnea, 10000);
});

test('事件累加：idle 丢弃，stopping 接受 flush 收尾的最后一条', () => {
  assert.equal(
    monitorReducer(initialMonitorState, { type: 'frame/event', event: event('snore', 1000) }),
    initialMonitorState
  );
  const stopping = run(initialMonitorState, [
    { type: 'start/begin' },
    { type: 'start/succeeded' },
    { type: 'stop/begin' },
  ]);
  const flushed = monitorReducer(stopping, { type: 'frame/event', event: event('snore', 2000) });
  assert.equal(flushed.events.length, 1);
  assert.equal(flushed.counts.snore, 1);
});

test('事件上限：达到 MAX_EVENTS_PER_SESSION 后只置截断标记，不再增长', () => {
  const monitoring = run(initialMonitorState, [{ type: 'start/begin' }, { type: 'start/succeeded' }]);
  const full: MonitorState = {
    ...monitoring,
    events: Array.from({ length: MAX_EVENTS_PER_SESSION }, (_, i) => event('snore', 1000, i)),
    counts: { snore: MAX_EVENTS_PER_SESSION, grind: 0, talk: 0, apnea: 0 },
  };
  const overflow = monitorReducer(full, { type: 'frame/event', event: event('snore', 1000) });
  assert.equal(overflow.events.length, MAX_EVENTS_PER_SESSION);
  assert.equal(overflow.eventsTruncated, true);
  // 已标记截断后再来帧仍是同一个对象，不重复渲染
  assert.equal(monitorReducer(overflow, { type: 'frame/event', event: event('snore', 1000) }), overflow);
});

test('裁剪回填：stopping 阶段替换事件表（playStart），idle 阶段拒绝', () => {
  const stopping = run(initialMonitorState, [
    { type: 'start/begin' },
    { type: 'start/succeeded' },
    { type: 'stop/begin' },
  ]);
  const replaced = monitorReducer(stopping, {
    type: 'frame/replace-events',
    events: [event('snore', 3000, 100)],
  });
  assert.deepEqual(replaced.events, [event('snore', 3000, 100)]);
  assert.equal(
    monitorReducer(initialMonitorState, { type: 'frame/replace-events', events: [] }),
    initialMonitorState
  );
});

test('进行中时长：只在 starting/monitoring 更新，且相同值不产生新对象', () => {
  const monitoring = run(initialMonitorState, [{ type: 'start/begin' }, { type: 'start/succeeded' }]);
  const withOngoing = monitorReducer(monitoring, { type: 'frame/ongoing', ms: 4000 });
  assert.equal(withOngoing.ongoingMs, 4000);
  assert.equal(monitorReducer(withOngoing, { type: 'frame/ongoing', ms: 4000 }), withOngoing);
  assert.equal(monitorReducer(initialMonitorState, { type: 'frame/ongoing', ms: 4000 }), initialMonitorState);
});

test('会话列表由 reducer 单点持有：sessions/set 覆盖旧值', () => {
  const session = {
    id: 's1',
    startTime: 1,
    durationSeconds: 60,
    events: [],
    snoreCount: 0,
    grindCount: 0,
    talkCount: 0,
    apneaCount: 0,
    totalSnoreSeconds: 0,
    totalGrindSeconds: 0,
    totalTalkSeconds: 0,
    totalApneaSeconds: 0,
    qualityScore: 100,
    apneaRisk: 'low' as const,
    intensityBreakdown: { mild: 0, moderate: 0, severe: 0 },
  };
  const next = monitorReducer(initialMonitorState, { type: 'sessions/set', sessions: [session] });
  assert.equal(next.sessions.length, 1);
  assert.equal(next.sessions[0].id, 's1');
});

test('阈值按调用时传入值生效：同一帧在不同阈值下判定不同', () => {
  const frame = {
    topClass: 'snoring',
    confidences: { snoring: 0.6, grinding: 0.1, talking: 0.05, apnea: 0.05 },
    amplitudeDb: -30,
  };
  const strict = classifyFrame(frame, { snore: 0.9, grind: 0.4, talk: 0.55 });
  const loose = classifyFrame(frame, { snore: 0.55, grind: 0.4, talk: 0.55 });
  assert.equal(strict.snore, false);
  assert.equal(loose.snore, true);
});

test('阈值没有内部缓存：连续用不同阈值判定互不影响', () => {
  const frame = {
    topClass: 'snoring',
    confidences: { snoring: 0.6, grinding: 0.1, talking: 0.05, apnea: 0.05 },
    amplitudeDb: -30,
  };
  assert.equal(classifyFrame(frame, { snore: 0.55, grind: 0.4, talk: 0.55 }).snore, true);
  assert.equal(classifyFrame(frame, { snore: 0.9, grind: 0.4, talk: 0.55 }).snore, false);
  assert.equal(classifyFrame(frame, { snore: 0.55, grind: 0.4, talk: 0.55 }).snore, true);
});
