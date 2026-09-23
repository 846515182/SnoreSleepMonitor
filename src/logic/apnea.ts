/**
 * 疑似呼吸暂停（连续无声）判定 —— 纯逻辑，可单元测试。
 *
 * 设计要点（修正了旧实现的两个致命问题）：
 *  1. 旧实现对「静音时长」没有上限：安静一整夜后早上闹钟一响，会生成一条横跨整晚的
 *     “呼吸暂停”事件（时长可达数小时），并把“呼吸暂停时长”统计撑爆。
 *     现在超过 maxSilenceMs（默认 60 秒）的静音段直接判为「长时间安静」，不计为暂停。
 *  2. 旧实现只要“任意声音”恢复就结束一次暂停，且不要求暂停前有呼吸类声音上下文，
 *     导致不打鼾的用户在安静房间里也会被记为暂停。
 *     现在要求：结束声音必须是呼吸类声音（鼾声/喘息等），且静音开始前 contextMs 内
 *     出现过呼吸类声音。
 */

/** 暂停结束时可接受的呼吸类声音（鼾声帧或异常呼吸音） */
export interface ApneaSignal {
  /** 是否为呼吸类声音：鼾声帧，或 YAMNet 异常呼吸音（喘息/喘鸣/喷气） */
  breath: boolean;
  /** 是否为任意较响的声音（用于锚定静音起点，不要求是呼吸声） */
  loud: boolean;
}

export interface ApneaEvent {
  /** 相对会话开始的毫秒 */
  start: number;
  end: number;
  duration: number;
  /** 因超过时长上限被截断（默认策略下不会产生，保留字段供后续策略使用） */
  capped?: boolean;
}

export interface ApneaTrackerOptions {
  /** 判定为一次暂停的最小连续无声时长（毫秒） */
  minSilenceMs: number;
  /** 静音时长上限，超过则不计为暂停（默认 60s） */
  maxSilenceMs?: number;
  /** 静音开始前允许回溯的「最近呼吸声」窗口（默认 5 分钟） */
  contextMs?: number;
}

export const DEFAULT_MAX_APNEA_SILENCE_MS = 60 * 1000;
export const DEFAULT_SNORE_CONTEXT_MS = 5 * 60 * 1000;

/**
 * 将设置页 0.1–0.9 的滑块值映射为 10–30 秒的「连续无声」判定阈值。
 * （医学上呼吸暂停定义为气流停止 ≥10 秒）
 */
export function apneaMinSilenceMs(threshold: number): number {
  const clamped = Math.max(0.1, Math.min(0.9, threshold));
  return Math.round(10 + ((clamped - 0.1) / 0.8) * 20) * 1000;
}

export class ApneaTracker {
  private minSilenceMs: number;
  private maxSilenceMs: number;
  private contextMs: number;

  private silenceStartMs: number | null = null;
  private lastLoudMs: number | null = null;
  private lastBreathMs: number | null = null;

  constructor(options: ApneaTrackerOptions) {
    this.minSilenceMs = Math.max(0, options.minSilenceMs);
    this.maxSilenceMs = options.maxSilenceMs ?? DEFAULT_MAX_APNEA_SILENCE_MS;
    this.contextMs = options.contextMs ?? DEFAULT_SNORE_CONTEXT_MS;
  }

  /** 会话开始/阈值变化时重置状态 */
  reset(): void {
    this.silenceStartMs = null;
    this.lastLoudMs = null;
    this.lastBreathMs = null;
  }

  /** 仅更新阈值（不丢弃正在进行的静音状态） */
  setMinSilenceMs(ms: number): void {
    this.minSilenceMs = Math.max(0, ms);
  }

  getSilenceStartMs(): number | null {
    return this.silenceStartMs;
  }

  /**
   * 逐帧喂入判定信号。
   * @param elapsedMs 会话相对毫秒（单调递增）
   * @returns 若本帧结束了一次符合条件的静音，则返回该次疑似暂停事件；否则返回 null
   */
  onFrame(elapsedMs: number, signal: ApneaSignal): ApneaEvent | null {
    let emitted: ApneaEvent | null = null;

    if (signal.loud || signal.breath) {
      // 声音恢复，静音结束
      const start = this.silenceStartMs;
      if (start !== null) {
        this.silenceStartMs = null;
        const duration = elapsedMs - start;

        const withinRange = duration >= this.minSilenceMs && duration <= this.maxSilenceMs;
        // 结束这次静音的必须是呼吸类声音，否则只是环境噪音打断了安静时段
        const breathEnded = signal.breath;
        // 静音开始前 contextMs 内必须有呼吸类声音，否则说明用户可能不在录音环境里
        const hasContext =
          this.lastBreathMs !== null && start - this.lastBreathMs <= this.contextMs;

        if (withinRange && breathEnded && hasContext) {
          emitted = {
            start,
            end: elapsedMs,
            duration,
            capped: false,
          };
        }
      }
      if (signal.loud) this.lastLoudMs = elapsedMs;
      if (signal.breath) this.lastBreathMs = elapsedMs;
    } else if (this.silenceStartMs === null) {
      // 从最后一次响亮帧开始计算静音，避免起点晚于真实静默开始
      this.silenceStartMs = this.lastLoudMs !== null ? this.lastLoudMs : elapsedMs;
    }

    return emitted;
  }
}
