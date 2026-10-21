import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 回归防护：锁屏后仍然要能识别。
 *
 * RN 的 JavaTimerManager 在 Activity 暂停（锁屏 / 切后台）时会暂停所有 JS 定时器，
 * 以前识别完全依赖 setTimeout 轮询原生结果，锁屏那一刻这条链就断了 ——
 * 录音文件一直在写，事件一条都记不下来（真机反馈：整晚只有录音）。
 *
 * 现在原生每处理完一帧就主动 emitDeviceEvent 推送，这两个端点任何一端被删掉，
 * 都会立刻退回「只有录音」的状态，所以在这里钉死。
 */
const root = path.join(__dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('原生模块每帧主动推送结果', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(
    plugin.includes('emitDeviceEvent("AudioMeterResult"'),
    '原生模块没有推送 AudioMeterResult 事件'
  );
  const processWindow = plugin.slice(plugin.indexOf('private fun processWindow'));
  assert.ok(processWindow.includes('emitResult()'), 'processWindow 处理完一帧没有调用 emitResult()');
});

test('界面侧订阅了原生推送，并按 windowId 去重', () => {
  const app = read('App.tsx');
  assert.ok(app.includes("addListener('AudioMeterResult'"), 'App.tsx 没有订阅 AudioMeterResult');
  assert.ok(app.includes('if (windowId === lastWindowIdRef.current)'), '缺少 windowId 去重，会重复计帧');
});
