/**
 * 自适应噪声底（noise floor）跟踪 —— 纯逻辑，可单元测试。
 *
 * 为什么不能继续用固定 dB 阈值：
 *   安静卧室的底噪可能只有 -75dB，开着空调/风扇时能到 -45dB。
 *   同一个 `SNORE_MIN_DB = -48` 在安静房间意味着「比底噪高 27dB」，
 *   在空调房却几乎等于「任何声音都算鼾声」—— 这是跨设备、跨房间最大的误报来源。
 *
 * 这里用**最近 10 分钟的滑动 P10** 估计底噪：
 *   - 鼾声/说话之间总有换气停顿，停顿会落在 P10 附近，所以底噪不会被整段抬高；
 *   - 稳态空调/风扇连续响时 P10 会缓慢跟随，阈值随之抬高，避免把底噪记成事件；
 *   - 滑动窗口天然会「忘掉」几小时前的旧环境，换房间也能重新适应。
 *
 * 底噪只在收集到足够样本（约 20 秒）后才用于自适应阈值，避免开场一两帧异常值
 * 把整晚的判定带偏。
 */

import { percentile } from './events';

/** 至少积累这么多有效帧（约 20 秒）才认为底噪估计可用 */
export const CALIBRATION_SAMPLES = 20;
/** 滑动窗口帧数：约 10 分钟（YAMNet 一帧 0.975 秒） */
export const FLOOR_WINDOW_FRAMES = 600;
/** 取窗口内的 P10 作为底噪：落在换气停顿/安静间隙上 */
export const FLOOR_PERCENTILE = 0.1;
/** 底噪夹取范围：再低没有意义，再高说明环境已经很吵 */
export const MIN_FLOOR_DB = -80;
export const MAX_FLOOR_DB = -35;
/** 尚未校准时使用的保守底噪（-56dB 对应默认 -48dB 鼾声门槛） */
export const DEFAULT_FLOOR_DB = -56;
/** 低于该值视为原生层的「无音频」哨兵（-100），不参与统计 */
const SENTINEL_DB = -95;

export interface NoiseFloorSnapshot {
  /** 当前估计的环境底噪（dBFS） */
  floorDb: number;
  /** 本帧高出底噪多少 dB（无效帧为 0） */
  snrDb: number;
  /** 是否已积累足够样本，可启用自适应阈值 */
  calibrated: boolean;
  /** 当前窗口内的有效样本数 */
  samples: number;
}

export interface AdaptiveThresholds {
  snoreMinDb: number;
  turnMinDb: number;
  noiseMinDb: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class NoiseFloorTracker {
  private samples: number[] = [];

  reset(): void {
    this.samples = [];
  }

  /** 当前底噪估计（样本不足时回退到默认值） */
  get currentFloorDb(): number {
    if (this.samples.length === 0) return DEFAULT_FLOOR_DB;
    return clamp(percentile(this.samples, FLOOR_PERCENTILE), MIN_FLOOR_DB, MAX_FLOOR_DB);
  }

  get calibrated(): boolean {
    return this.samples.length >= CALIBRATION_SAMPLES;
  }

  /**
   * 喂一帧音量。
   * @param amplitudeDb 本帧音量（dBFS，-100 为原生哨兵值）
   */
  push(amplitudeDb: number): NoiseFloorSnapshot {
    const db = Number.isFinite(amplitudeDb) ? amplitudeDb : SENTINEL_DB;
    if (db > SENTINEL_DB) {
      this.samples.push(db);
      // 超出窗口就从头部丢弃：数组规模最多 600，shift 的开销可以忽略。
      if (this.samples.length > FLOOR_WINDOW_FRAMES) this.samples.shift();
    }
    const floorDb = this.currentFloorDb;
    return {
      floorDb,
      snrDb: db > SENTINEL_DB ? Math.max(0, db - floorDb) : 0,
      calibrated: this.calibrated,
      samples: this.samples.length,
    };
  }
}

/**
 * 由底噪推导三类事件的音量下限。
 *
 * 以 -56dB 的典型安静房间为基准，三个阈值分别等于原来的固定值
 * （-48 / -52 / -52）；房间更安静时阈值自动下探（能记到更轻的声音），
 * 房间更吵时自动抬高（避免底噪刷屏）。上下限防止极端值让阈值失效。
 */
export function adaptiveThresholds(floorDb: number): AdaptiveThresholds {
  return {
    snoreMinDb: clamp(floorDb + 8, -62, -32),
    turnMinDb: clamp(floorDb + 4, -60, -35),
    noiseMinDb: clamp(floorDb + 4, -62, -38),
  };
}
