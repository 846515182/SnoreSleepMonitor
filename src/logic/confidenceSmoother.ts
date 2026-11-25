/**
 * 置信度平滑 —— 纯逻辑，可单元测试。
 *
 * YAMNet 是逐帧（0.975 秒）独立推理的，同一段鼾声在相邻帧上的置信度会来回跳：
 * 0.62 → 0.38 → 0.66 … 直接拿单帧过阈值会把一段连续声音切成一堆碎片，
 * 或者让一条事件在边界上反复开关。
 *
 * 这里用「快攻慢放」的指数滑动平均（EMA）：
 *   - 置信度上升时用较大的 alpha（快攻），新事件第一帧就能过阈值；
 *   - 下降时用较小的 alpha（慢放），短暂掉帧不会立刻结束事件；
 *   - 上一帧已经衰减到 5% 以下时直接吸附到本帧值，
 *     保证只有一两帧的短梦话/咳嗽不会被平滑掉。
 */

/** 快攻系数：越大越信任当前帧 */
export const SMOOTH_ATTACK = 0.6;
/** 慢放系数：越小越不容易被单帧抖动打断 */
export const SMOOTH_RELEASE = 0.25;
/** 低于该值的残留直接吸附到本帧，保证短事件能立即进入 */
export const SMOOTH_SNAP = 0.05;

/** 事件类别（排除 noise，噪音只是兜底） */
export const EVENT_CLASS_KEYS = ['snoring', 'grinding', 'talking', 'apnea', 'turn'] as const;
export type EventClassKey = (typeof EVENT_CLASS_KEYS)[number];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class ConfidenceSmoother {
  private values: Record<string, number> = {};

  reset(): void {
    this.values = {};
  }

  /** 当前平滑后的置信度（调试/测试用） */
  get snapshot(): Record<string, number> {
    return { ...this.values };
  }

  /**
   * 喂一帧原始置信度，返回平滑后的置信度。
   * 缺失的类别按 0 处理并缓慢衰减，避免上一帧的高分永远挂在那里。
   */
  push(input: Record<string, number>): Record<string, number> {
    const next: Record<string, number> = {};
    const keys = new Set([...Object.keys(this.values), ...Object.keys(input)]);
    for (const key of keys) {
      const target = clamp01(input[key] ?? 0);
      const prev = this.values[key] ?? 0;
      if (target >= prev) {
        next[key] = prev <= SMOOTH_SNAP ? target : prev + (target - prev) * SMOOTH_ATTACK;
      } else {
        next[key] = prev + (target - prev) * SMOOTH_RELEASE;
      }
    }
    this.values = next;
    return { ...next };
  }
}

/**
 * 从平滑后的置信度里取 top 事件类别。
 * 全为 0（静音/纯噪音帧）时返回 'noise'，与原生层的约定保持一致。
 */
export function topEventClass(confidences: Record<string, number>): string {
  let best = 'noise';
  let bestValue = 0;
  for (const key of EVENT_CLASS_KEYS) {
    const value = confidences[key] ?? 0;
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}
