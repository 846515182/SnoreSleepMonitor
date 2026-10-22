/**
 * 声音事件状态机 —— 纯逻辑，可在电脑上喂「模拟的一整晚」做回归。
 *
 * 之前这套逻辑写在 App.tsx 里，只能靠人肉读；现在抽出来，
 * 单元测试里可以按 0.975 秒一帧喂真实节奏的鼾声/梦话/暂停，断言事件数。
 */

import type { SoundEvent } from '../types';
import { classifyFinalEvent, GRACE_MS } from './events';

/**
 * 两帧之间超过这个间隔就认为中间断过（锁屏定时器被暂停、应用被冻结、
 * 甚至系统时间跳变）。以前这种情况会把几十秒的空档算进同一个事件，
 * 生成一条横跨半小时的假「鼾声」。
 */
export const MAX_FRAME_GAP_MS = 5000;

interface Draft {
  start: number;
  end: number;
  snoreFrames: number;
  grindFrames: number;
  talkFrames: number;
  totalFrames: number;
  maxSnoreConf: number;
}

export interface DetectorFrame {
  snore: boolean;
  grind: boolean;
  talk: boolean;
}

export class SoundEventDetector {
  private draft: Draft | null = null;
  private lastLoudMs = 0;
  private lastFrameMs = 0;

  reset(): void {
    this.draft = null;
    this.lastLoudMs = 0;
    this.lastFrameMs = 0;
  }

  /** 正在进行的这一段已持续多久（给界面上的「噪音时长」用） */
  get ongoingDurationMs(): number {
    return this.draft ? this.draft.end - this.draft.start : 0;
  }

  get hasOpenEvent(): boolean {
    return this.draft !== null;
  }

  /**
   * 喂一帧。
   * @param elapsedMs 会话相对毫秒（单调递增）
   * @param frame 本帧的分类结果
   * @param snoreConf 本帧鼾声置信度（用于强度分级）
   * @returns 本帧导致事件落定时返回该事件，否则 null
   */
  push(elapsedMs: number, frame: DetectorFrame, snoreConf: number): SoundEvent | null {
    // 时钟回拨/时间戳异常：按上一帧处理，避免负时长
    const t = Math.max(elapsedMs, this.lastFrameMs);
    this.lastFrameMs = t;

    const loud = frame.snore || frame.grind || frame.talk;
    let finalized: SoundEvent | null = null;

    if (loud) {
      // 断帧太久：先结掉上一段，绝不能把空白并进来
      if (this.draft && t - this.draft.end > MAX_FRAME_GAP_MS) {
        finalized = this.finalize();
      }
      this.lastLoudMs = t;
      if (!this.draft) {
        this.draft = {
          start: t,
          end: t,
          snoreFrames: 0,
          grindFrames: 0,
          talkFrames: 0,
          totalFrames: 0,
          maxSnoreConf: 0,
        };
      }
      const d = this.draft;
      d.end = t;
      d.totalFrames += 1;
      if (frame.snore) {
        d.snoreFrames += 1;
        if (snoreConf > d.maxSnoreConf) d.maxSnoreConf = snoreConf;
      }
      if (frame.grind) d.grindFrames += 1;
      if (frame.talk) d.talkFrames += 1;
    } else if (this.draft && t - this.lastLoudMs >= GRACE_MS) {
      // 静音超过宽限期才收尾：鼾声的呼吸间隔（1–2 秒）不会把一次打鼾拆成好几条
      finalized = this.finalize();
    }

    return finalized;
  }

  /** 停止监测时把进行中的一段落定 */
  flush(): SoundEvent | null {
    return this.finalize();
  }

  private finalize(): SoundEvent | null {
    const d = this.draft;
    this.draft = null;
    if (!d) return null;

    const duration = d.end - d.start;
    const classified = classifyFinalEvent(
      duration,
      {
        snore: d.snoreFrames,
        grind: d.grindFrames,
        talk: d.talkFrames,
        total: d.totalFrames,
      },
      d.maxSnoreConf
    );
    if (!classified) return null;

    return {
      start: d.start,
      end: d.end,
      duration,
      type: classified.type,
      intensity: classified.intensity,
    };
  }
}
