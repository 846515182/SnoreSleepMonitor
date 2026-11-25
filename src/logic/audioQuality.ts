/**
 * 录音质量监测 —— 纯逻辑，可单元测试。
 *
 * 识别结果再准，也架不住「麦克风被被子盖住」「手机离嘴太远」「整晚空调轰鸣」。
 * 这里把三件可观测的事汇总成一条用户能看懂的结论：
 *   - 覆盖率：实际收到的音频帧 / 按时间应产生的帧。掉帧说明应用被系统冻结或录音线程中断；
 *   - 削波率：峰值贴近满量程。手机放太近、鼾声太大时会削顶，波形失真会影响识别；
 *   - 环境底噪与信噪比：底噪高、有效声音只比底噪高几 dB 时，识别可信度下降。
 *
 * 结论只分「良好 / 一般 / 较差」，并附具体中文原因，方便用户调整手机位置或关闭空调。
 */

import type { AudioQuality, AudioQualityLevel } from '../types';

/** YAMNet 单帧时长（毫秒），用于由会话时长推算应有多少帧 */
export const QUALITY_WINDOW_MS = 975;
/** 峰值达到 -1dBFS 视为削波（PCM 峰值接近 32767） */
export const CLIP_PEAK_DB = -1;
/** 原生层无音频哨兵 */
const SENTINEL_DB = -95;
/** 信噪比样本少于该数量时不做判断，避免刚开场的几帧决定整晚结论 */
const MIN_SNR_SAMPLES = 20;

export interface QualityFrameInput {
  amplitudeDb: number;
  /** 本帧峰值（dBFS），原生层新增字段；旧版本不传时忽略 */
  peakDb?: number;
  /** 原生层直接给出的削波标记 */
  clipped?: boolean;
  /** 仅对「明显高于底噪」的帧提供：本帧高出底噪多少 dB */
  snrDb?: number;
}

export class SignalQualityMonitor {
  private frames = 0;
  private clippedFrames = 0;
  private sentinelFrames = 0;
  private snrSum = 0;
  private snrCount = 0;

  reset(): void {
    this.frames = 0;
    this.clippedFrames = 0;
    this.sentinelFrames = 0;
    this.snrSum = 0;
    this.snrCount = 0;
  }

  push(frame: QualityFrameInput): void {
    this.frames += 1;
    if (
      frame.clipped === true ||
      (typeof frame.peakDb === 'number' && Number.isFinite(frame.peakDb) && frame.peakDb >= CLIP_PEAK_DB)
    ) {
      this.clippedFrames += 1;
    }
    if (!Number.isFinite(frame.amplitudeDb) || frame.amplitudeDb <= SENTINEL_DB) {
      this.sentinelFrames += 1;
    }
    if (typeof frame.snrDb === 'number' && Number.isFinite(frame.snrDb)) {
      this.snrSum += frame.snrDb;
      this.snrCount += 1;
    }
  }

  /**
   * 生成会话级质量结论。
   * @param durationMs 会话时长（毫秒）
   * @param noiseFloorDb 结束时估计的环境底噪（dBFS）
   */
  summary(durationMs: number, noiseFloorDb: number): AudioQuality | undefined {
    if (this.frames <= 0) return undefined;

    const expectedFrames = Math.max(1, Math.round(durationMs / QUALITY_WINDOW_MS));
    const coverage = Math.max(0, Math.min(1, this.frames / expectedFrames));
    const clippedRatio = this.clippedFrames / this.frames;
    const sentinelRatio = this.sentinelFrames / this.frames;
    const avgSnrDb = this.snrCount > 0 ? this.snrSum / this.snrCount : 0;
    const snrReliable = this.snrCount >= MIN_SNR_SAMPLES;

    const issues: string[] = [];
    if (coverage < 0.9) {
      issues.push(`约 ${Math.round((1 - coverage) * 100)}% 的音频帧未收到`);
    }
    if (clippedRatio > 0.05) {
      issues.push('麦克风存在削波，建议手机离嘴部稍远');
    }
    if (noiseFloorDb > -45) {
      issues.push('环境底噪偏高，可能影响识别准确度');
    }
    if (snrReliable && avgSnrDb < 12) {
      issues.push('有效声音与底噪差距较小');
    }
    if (sentinelRatio > 0.3) {
      issues.push('部分时段未采集到音频');
    }

    const poor =
      coverage < 0.7 ||
      clippedRatio > 0.2 ||
      sentinelRatio > 0.3 ||
      noiseFloorDb > -38 ||
      (snrReliable && avgSnrDb < 6);
    const fair =
      !poor &&
      (coverage < 0.9 ||
        clippedRatio > 0.05 ||
        noiseFloorDb > -45 ||
        (snrReliable && avgSnrDb < 12));

    const level: AudioQualityLevel = poor ? 'poor' : fair ? 'fair' : 'good';
    return {
      level,
      coverage: Math.round(coverage * 100) / 100,
      clippedRatio: Math.round(clippedRatio * 1000) / 1000,
      avgSnrDb: Math.round(avgSnrDb * 10) / 10,
      noiseFloorDb: Math.round(noiseFloorDb * 10) / 10,
      issues,
    };
  }
}
