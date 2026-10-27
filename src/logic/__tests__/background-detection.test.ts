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
  assert.ok(
    app.includes('windowId <= lastWindowIdRef.current'),
    '缺少 windowId 去重，会重复计帧'
  );
  assert.ok(app.includes('windowId < 0'), '新会话第一帧 windowId=-1 应被忽略');
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

test('设置页改阈值不会把降噪/录音偏好覆盖掉', () => {
  const app = read('App.tsx');
  const saveSettings = app.slice(
    app.indexOf('const saveSettings'),
    app.indexOf('const applySaveRecordingPref')
  );
  assert.ok(saveSettings.includes('updateStoredSettings'), '保存设置没有走合并写入');
  assert.ok(saveSettings.includes('denoiseRecording'), '改阈值时漏写 denoiseRecording，重启后降噪会丢');
  assert.ok(saveSettings.includes('saveRecording'), '改阈值时漏写 saveRecording');
  assert.ok(saveSettings.includes('keepFullRecording'), '改阈值时漏写 keepFullRecording');
});

test('监测中改阈值：原生和轮询路径都读最新值', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('AudioMeter.setThresholds(nextSnore'), '监测中改阈值没有同步给原生');
  assert.ok(app.includes('thresholdsRef.current'), '轮询闭包没有读最新阈值');
});

test('停止监测：先写历史记录，再删进行中快照', () => {
  const app = read('App.tsx');
  const persistAt = app.indexOf('await persistSessions(nextSessions)');
  const clearAt = app.indexOf('await clearActiveSnapshot()', persistAt);
  assert.ok(persistAt >= 0, '停止监测没有显式持久化历史记录');
  assert.ok(clearAt > persistAt, '必须先写历史记录再删快照，否则极端时机会丢整晚记录');
});

test('回放：只有当前加载的录音与所选会话一致才直接 seek', () => {
  const app = read('App.tsx');
  assert.ok(
    app.includes('loadedRecordingUriRef.current === selectedSession.recordingUri'),
    '缺少录音归属校验，切会话后可能拿上一条音频播放'
  );
});

test('原生 WAV：录音写入与 header flush 共用同一把锁', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(plugin.includes('synchronized(out) {'), 'header 线程 flush 没有和录音写入串行化');
  assert.ok(plugin.includes('out.flush()'), 'header 线程没有 flush');
  assert.ok(plugin.includes('synchronized(stream) {'), '录音写入没有和 header/close 串行化');
  assert.ok(plugin.includes('synchronized(it) {'), 'releaseResources 关闭 WAV 时没有加锁');
});

test('原生推理异常后仍推送一帧', () => {
  const plugin = read('plugins/withAudioMeter.js');
  const processWindow = plugin.slice(plugin.indexOf('private fun processWindow'));
  const catchBlock = processWindow.slice(processWindow.indexOf('} catch (e: Exception)'));
  assert.ok(catchBlock.includes('emitResult()'), '推理异常后不推送会让 JS 端长时间停在上一帧');
});

test('原生重复 start 不能清理正在录制的 WAV', () => {
  const plugin = read('plugins/withAudioMeter.js');
  const start = plugin.slice(
    plugin.indexOf('fun startRecording('),
    plugin.indexOf('fun stopRecording(')
  );
  assert.ok(start.includes('val alreadyRecording = synchronized(lock)'), '重复 start 没有在 try 外拦截');
  assert.ok(
    start.indexOf('val alreadyRecording') < start.indexOf('var createdFile'),
    '重复 start 的拒绝路径必须在创建/清理资源之前'
  );
  assert.ok(start.includes('createdFile?.let'), '启动失败只能删除本次创建的文件');
  assert.ok(
    !start.includes('if (wavFilePath.isNotEmpty())'),
    '启动失败路径不能再按全局 wavFilePath 删文件'
  );
});

test('原生 new start 复位窗口与 stalled，windowId 最后原子提交', () => {
  const plugin = read('plugins/withAudioMeter.js');
  const start = plugin.slice(plugin.indexOf('fun startRecording('), plugin.indexOf('fun stopRecording('));
  assert.ok(start.includes('latestWindowId = -1'), 'start 没有复位 windowId');
  assert.ok(start.includes('stalled = false'), 'start 没有复位 stalled');
  assert.ok(start.includes('lastAudioAt = System.currentTimeMillis()'), 'start 没有复位音频心跳');
  assert.ok(!plugin.includes('latestWindowId += 1'), 'windowId 不能先自增再推理，会撕裂快照');
  const process = plugin.slice(plugin.indexOf('private fun processWindow'), plugin.indexOf('private fun createInputBuffer'));
  assert.ok(process.includes('latestWindowId = windowId'), '推理结果必须和 windowId 一起提交');
  assert.ok(process.includes('filterKeys { it != "noise" }'), 'noise 残差不应压过事件类别');
});

test('原生音频线程有会话 token 和异常自清理', () => {
  const plugin = read('plugins/withAudioMeter.js');
  const thread = plugin.slice(plugin.indexOf('private fun startAudioProcessing'), plugin.indexOf('private fun processWindow'));
  assert.ok(thread.includes('while (isRecording && audioSessionId == session)'), '旧线程不能继续读新会话');
  assert.ok(thread.includes('abnormalExit = true'), '线程异常退出没有标记');
  assert.ok(thread.includes('releaseResources()'), '线程异常退出没有释放麦克风/文件');
  assert.ok(thread.includes('stopForegroundService()'), '线程异常退出没有停前台服务');
});

test('中断恢复不删录音，且先落盘再删快照', () => {
  const app = read('App.tsx');
  const restore = app.slice(
    app.indexOf('const restoreActiveSession'),
    app.indexOf('const writeActiveSnapshot')
  );
  assert.ok(!restore.includes('deleteAsync(snap.recordingUri'), '恢复中断会话不能无条件删除录音');
  assert.ok(restore.includes('recordingUri,'), '恢复会话没有保留可播放录音');
  assert.ok(restore.includes('canPersist'), '恢复流程没有区分历史是否加载成功');
  const persistAt = restore.indexOf('await persistSessions(next)');
  const clearAt = restore.indexOf('removeItem(ACTIVE_SESSION_KEY)', persistAt);
  assert.ok(persistAt >= 0 && clearAt > persistAt, '恢复后必须先落盘再删快照');
});

test('历史读取失败不能把空数组写回存储', () => {
  const app = read('App.tsx');
  const load = app.slice(app.indexOf('const loadSessions'), app.indexOf('const restoreActiveSession'));
  assert.ok(load.includes('return false'), 'loadSessions 读取/解析失败必须返回 false');
  assert.ok(app.includes('setSessionsHydrated(sessionsLoaded)'), '启动流程没有使用加载结果');
  const stop = app.slice(app.indexOf('const stopMonitoring'), app.indexOf('const playRecording'));
  assert.ok(stop.includes('if (sessionsHydrated)'), '历史未加载时停止监测仍会覆盖存储');
});

test('播放请求有 generation，离开详情页不会被迟到的 createAsync 重新播放', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('playbackGenerationRef'), '缺少播放 generation');
  assert.ok(app.includes('const isCurrent = () =>'), '播放加载没有失效检查');
  assert.ok(app.includes('if (!isCurrent()) return false;'), '可重入检查缺失');
  const stop = app.slice(app.indexOf('const stopPlayback'), app.indexOf('const acceptPrivacy'));
  assert.ok(stop.includes('playbackGenerationRef.current += 1'), 'stopPlayback 没有作废在途播放');
});

test('启动监测有同步锁，且历史未加载时禁止启动', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('startInFlightRef'), '缺少同步启动锁');
  const start = app.slice(app.indexOf('const startMonitoring'), app.indexOf('const applyNativeResult'));
  assert.ok(start.includes('if (startInFlightRef.current) return;'), '双击仍可能启动两次');
  assert.ok(start.includes('if (!sessionsHydrated)'), '历史读取失败时仍允许开始监测，可能覆盖旧记录');
  assert.ok(start.includes('if (freeBytes < MIN_FREE_STORAGE_BYTES)'), '存储预检缺失');
  const storageBlock = start.slice(start.indexOf('if (freeBytes < MIN_FREE_STORAGE_BYTES)'));
  assert.ok(storageBlock.includes('return;'), '空间不足只弹窗却继续启动，会写满磁盘');
});

test('停止监测有同步锁，迟到快照写入不会在 clear 之后复活', () => {
  const app = read('App.tsx');
  const stop = app.slice(app.indexOf('const stopMonitoring'), app.indexOf('const deleteSession'));
  assert.ok(stop.includes('stopInFlightRef.current = true'), '缺少同步停止锁');
  assert.ok(stop.includes('activeSnapshotShouldExistRef.current = false'), '落盘成功后没有作废进行中快照');
  assert.ok(app.includes('sessionTokenRef'), '快照没有会话 token');
  assert.ok(app.includes('snapshotWriteChainRef'), '快照写入没有串行化');
  const clear = app.slice(app.indexOf('const clearActiveSnapshot'), app.indexOf('const persistSessions'));
  assert.ok(clear.includes('snapshotWriteChainRef.current.then'), 'clear 没有排在旧快照写入之后');
});

test('裁剪完成后的快照保留 snore 模式和 playStart', () => {
  const app = read('App.tsx');
  const stop = app.slice(app.indexOf('const stopMonitoring'), app.indexOf('const deleteSession'));
  assert.ok(stop.includes("recordingModeRef.current = 'snore'"), '裁剪后快照没有记录 snore 模式');
  assert.ok(stop.includes("recordingUriRef.current = cut"), '裁剪后快照仍指向已删除的原始 WAV');
  assert.ok(stop.includes('await writeActiveSnapshot(endTime - startTimeRef.current, true)'), '停止时没有补最终快照');
  const restore = app.slice(app.indexOf('const restoreActiveSession'), app.indexOf('const writeActiveSnapshot'));
  assert.ok(restore.includes("snap.recordingMode === 'snore'"), '恢复时没有还原裁剪模式');
});

test('旧播放请求失败不会停掉已经开始的下一段播放', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('const requestGeneration = playbackGenerationRef.current'), '没有记录本次播放代次');
  const guards = app.match(/playbackGenerationRef\.current === requestGeneration/g) || [];
  assert.ok(guards.length >= 3, '连播/整晚/单事件三条路径都可能误停新播放');
  const seek = app.slice(app.indexOf('const seekToEvent'), app.indexOf('const stopPlayback'));
  assert.ok(seek.includes('playbackGenerationRef.current !== seekGeneration'), '直接 seek 完成后没有校验代次');
});

test('原生 header 线程带会话 token，不会给新会话写头', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(plugin.includes('private fun startHeaderUpdater(session: Int)'), 'header 线程没有会话隔离');
  assert.ok(plugin.includes('while (isRecording && audioSessionId == session)'), '旧 header 线程会继续运行');
  assert.ok(plugin.includes('if (audioSessionId != session) break'), 'sleep 后没有再次检查会话');
  // synchronized { flush(); if (...) update... } 的 lambda 最后一条是 if，
  // 没有 else 时 Kotlin 会把 if 当表达式而编译失败；显式 Unit 收尾。
  assert.ok(plugin.includes('                            Unit'), 'synchronized lambda 缺少 Unit，Kotlin 编译会失败');
});

test('原生裁剪读到 EOF 会失败并保留原文件', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(
    plugin.includes('Unexpected end of source WAV while cutting'),
    '读到 EOF 被当成正常结束，可能删掉不完整源文件'
  );
  assert.ok(plugin.includes('outFile?.delete()'), '裁剪异常没有清理半截输出文件');
});

test('原生前台服务启动失败不再被吞掉', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(
    plugin.includes('throw IllegalStateException("Failed to start foreground service'),
    'FGS 启动失败仍假装录音成功'
  );
});

test('原生音频心跳：saveRecording=false 也能发现录音线程停摆', () => {
  const plugin = read('plugins/withAudioMeter.js');
  assert.ok(plugin.includes('lastAudioAt'), '缺少音频读取心跳');
  assert.ok(plugin.includes('heartbeatStalled'), '快照没有根据心跳上报 stalled');
});
