/**
 * 声音事件状态机 —— 纯逻辑，可在电脑上喂「模拟的一整晚」做回归。
 *
 * 除了帧数/占比，这里还收集两个决定「是不是真鼾声」的量：
 *   - 整段事件的音量起伏（P90-P10）：稳态噪声几乎没有起伏；
 *   - 连续鼾声帧的段数（响—停回合）：真人打鼾是跟着呼吸一截一截的。
 * 判定在 classifyFinalEvent 里，测试覆盖了风扇/电视/翻身/单帧误触等噪声场景。
 */

import type { SoundEvent } from '../types';
import { classifyFinalEvent, GRACE_MS, MAX_NOISE_MS, percentile } from './events';

/**
 * 两帧之间超过这个间隔就认为中间断过（锁屏定时器被暂停、应用被冻结、
 * 甚至系统时间跳变）。以前这种情况会把几十秒的空档算进同一个事件，
 * 生成一条横跨半小时的假「鼾声」。
 */
export const MAX_FRAME_GAP_MS = 5000;

/**
 * 低于这个音量的帧不参与包络统计。
 * 原生层在推理失败/完全无声时会给出 -100 这个哨兵值，如果把它算进去，
 * 任何一段声音的 P90-P10 都会被撑大，稳态噪声反而能混过「音量起伏」检查。
 */
const MOD_DB_FLOOR = -90;

function pushDb(draft: { dbs: number[] }, db: number): void {
  if (Number.isFinite(db) && db > MOD_DB_FLOOR) draft.dbs.push(db);
}

interface Draft {
  start: number;
  end: number;
  snoreFrames: number;
  grindFrames: number;
  talkFrames: number;
  turnFrames: number;
  noiseFrames: number;
  totalFrames: number;
  maxSnoreConf: number;
  /** 事件期间每一帧的音量（含换气停顿），用于算包络起伏 */
  dbs: number[];
  /** 连续的鼾声帧算一个回合 */
  bursts: number;
  lastWasSnore: boolean;
  /** 最近一个「明确类型」帧（鼾声/磨牙/梦话/翻身）的时间；用于把尾随的连续噪音切开 */
  lastTypedMs: number;
  /** 噪音帧识别到的声音标签计数，事件结束时取出现最多的一个 */
  labelCounts: Map<string, number>;
}

function topLabel(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

export interface DetectorFrame {
  snore: boolean;
  grind: boolean;
  talk: boolean;
  /** 翻身/床体噪声帧（可选：旧调用方不传时按 false 处理） */
  turn?: boolean;
  /** 其他可听声音帧（裁剪到环境噪音事件） */
  noise?: boolean;
  /** YAMNet 原始类别映射出的中文标签，用于给噪音事件加文字说明 */
  soundLabel?: string;
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
   * @param db 本帧音量（dBFS），用于判断呼吸包络
   * @returns 本帧导致事件落定时返回该事件，否则 null
   */
  push(
    elapsedMs: number,
    frame: DetectorFrame,
    snoreConf: number,
    db: number
  ): SoundEvent | null {
    // 时钟回拨/时间戳异常：按上一帧处理，避免负时长
    const t = Math.max(elapsedMs, this.lastFrameMs);
    this.lastFrameMs = t;

    const typed = frame.snore || frame.grind || frame.talk || frame.turn === true;
    const noise = frame.noise === true && !typed;
    const loud = typed || noise;
    let finalized: SoundEvent | null = null;

    if (!loud) {
      if (this.draft) {
        // 换气/静音帧也是一个「响—停」回合的结束
        this.draft.lastWasSnore = false;
        // 静音帧也纳入包络统计（真人鼾声之间就是 1–2 秒的换气停顿）
        pushDb(this.draft, db);
        if (t - this.lastLoudMs >= GRACE_MS) {
          finalized = this.finalize();
        }
      }
      return finalized;
    }

    // 断帧太久：先结掉上一段，绝不能把空白并进来
    if (this.draft && t - this.draft.end > MAX_FRAME_GAP_MS) {
      finalized = this.finalize();
    }

    /**
     * 切段规则：
     * 1. 任何连续声音段最长 MAX_NOISE_MS（1 小时），超出就切成新的一段。
     *    风扇/空调这类被误判成鼾声的稳定声音不会变成横跨几小时的假事件；
     *    几分钟的连续鼾声仍然保持一条，不会被切碎。
     * 2. 明确类型的事件结束后只剩连续环境噪音时，最多再延长 GRACE_MS，
     *    否则一条鼾声会被尾随底噪无限拉长，占比被稀释。
     */
    if (this.draft) {
      const d = this.draft;
      const hasTyped = d.totalFrames - d.noiseFrames > 0;
      if (t - d.start >= MAX_NOISE_MS) {
        finalized = this.finalize();
      } else if (hasTyped && noise && t - d.lastTypedMs >= GRACE_MS) {
        finalized = this.finalize();
      }
    }

    this.lastLoudMs = t;
    if (!this.draft) {
      this.draft = {
        start: t,
        end: t,
        snoreFrames: 0,
        grindFrames: 0,
        talkFrames: 0,
        turnFrames: 0,
        noiseFrames: 0,
        totalFrames: 0,
        maxSnoreConf: 0,
        dbs: [],
        bursts: 0,
        lastWasSnore: false,
        lastTypedMs: t,
        labelCounts: new Map(),
      };
    }
    const d = this.draft;
    d.end = t;
    d.totalFrames += 1;
    pushDb(d, db);
    if (typed) d.lastTypedMs = t;
    if (frame.snore) {
      d.snoreFrames += 1;
      if (snoreConf > d.maxSnoreConf) d.maxSnoreConf = snoreConf;
      if (!d.lastWasSnore) d.bursts += 1;
      d.lastWasSnore = true;
    } else {
      d.lastWasSnore = false;
    }
    if (frame.grind) d.grindFrames += 1;
    if (frame.talk) d.talkFrames += 1;
    if (frame.turn) d.turnFrames += 1;
    if (noise) d.noiseFrames += 1;
    const label = frame.soundLabel?.trim();
    if (label) d.labelCounts.set(label, (d.labelCounts.get(label) ?? 0) + 1);

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
        turn: d.turnFrames,
        noise: d.noiseFrames,
        total: d.totalFrames,
      },
      d.maxSnoreConf,
      {
        modulationDb: percentile(d.dbs, 0.9) - percentile(d.dbs, 0.1),
        bursts: d.bursts,
      }
    );
    if (!classified) return null;

    const event: SoundEvent = {
      start: d.start,
      end: d.end,
      duration,
      type: classified.type,
      intensity: classified.intensity,
    };
    if (classified.type === 'noise') {
      const label = topLabel(d.labelCounts);
      if (label) event.soundLabel = label;
    }
    return event;
  }
}
