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

/**
 * 录音降噪（v1.6.3）：只处理写入 WAV 的 PCM，识别仍用原始采样。
 * 原生侧是二阶 Butterworth 高通，JS 侧负责把设置传给原生。两端任何一端断开，
 * 要么「降噪不生效」要么「把轻声鼾声一起滤掉导致漏记」，所以钉死这两条链。
 */
test('原生降噪：有 80Hz 高通，且只作用于落盘音频', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(plugin.includes('fun setDenoise(enabled: Boolean'), '原生模块缺少 setDenoise 方法');
  assert.ok(plugin.includes('hpB0'), '原生模块缺少二阶高通系数（hpB0）');
  assert.ok(plugin.includes('val y = hpB0 * x + hpB1 * hpX1'), '高通滤波没有按 biquad 递推实现');
  // 高通只应该在写 WAV 的分支里跑，送入 YAMNet 的 ring 不能被动过
  const writeBlock = plugin.slice(plugin.indexOf('val out = wavOut'));
  const ringBlock = plugin.slice(plugin.indexOf('Accumulate for inference'));
  assert.ok(writeBlock.includes('denoiseEnabled'), '写 WAV 分支没有接入降噪开关');
  assert.ok(!ringBlock.includes('hpB0'), '送入识别的采样不应被高通滤波');
});

test('界面侧：降噪设置已接通原生 setDenoise', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('denoiseRecording'), 'App.tsx 缺少 denoiseRecording 状态');
  assert.ok(app.includes('AudioMeter.setDenoise(denoiseRecording)'), '开始监测时没有把降噪设置传给原生');
  assert.ok(app.includes('录音降噪'), '设置页缺少「录音降噪」入口');
});
