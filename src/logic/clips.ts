/**
 * 鼾声片段连播（Snore Clips）：从整晚录音中挑出鼾声事件并逐段回放。
 *
 * 这里只放与 UI 无关的纯函数（窗口计算 / 推进决策 / 片段筛选），
 * 便于在没有设备的环境下做单元测试；播放状态机在 App.tsx 里消费这些函数。
 */

import type { SoundEvent } from '../types';

/** 片段起点向前保留的上下文（听到起鼾前的一瞬） */
export const CLIP_PAD_BEFORE_MS = 300;

/** 片段终点向后多播的收尾（不截断尾音） */
export const CLIP_PAD_AFTER_MS = 700;

export interface ClipWindow {
  /** 可播放起点（已钳到 0） */
  start: number;
  /** 可播放终点（已按音频总长钳制） */
  end: number;
}

/**
 * 计算某个事件的可播放窗口。
 * - 起点前留 CLIP_PAD_BEFORE_MS 上下文，且不小于 0；
 * - 终点后留 CLIP_PAD_AFTER_MS 收尾；已知音频总长时钳到总长内；
 * - 退化窗口（end <= start，来自脏数据或钳制）兜底为起点后 1 秒，保证至少能播一段。
 */
export function clipWindow(evt: SoundEvent, audioDurationMs?: number): ClipWindow {
  const start = Math.max(0, evt.start - CLIP_PAD_BEFORE_MS);
  let end = evt.end + CLIP_PAD_AFTER_MS;
  if (typeof audioDurationMs === 'number' && audioDurationMs > 0) {
    end = Math.min(end, audioDurationMs);
  }
  if (end <= start) {
    end = start + 1000;
  }
  return { start, end };
}

/** 某事件的可播放起点 */
export function clipStartMs(evt: SoundEvent, audioDurationMs?: number): number {
  return clipWindow(evt, audioDurationMs).start;
}

/** 播放位置是否已到达当前片段的可播放终点 */
export function clipFinished(
  evt: SoundEvent,
  positionMs: number,
  audioDurationMs?: number
): boolean {
  return positionMs >= clipWindow(evt, audioDurationMs).end;
}

/**
 * 连播的下一片段索引。
 * @returns 未到终点返回当前 idx；到终点返回 idx + 1；返回 clips.length 表示全部播完
 */
export function nextClipIndex(
  clips: readonly SoundEvent[],
  idx: number,
  positionMs: number,
  audioDurationMs?: number
): number {
  if (idx < 0 || idx >= clips.length) return clips.length;
  if (!clipFinished(clips[idx], positionMs, audioDurationMs)) return idx;
  return idx + 1;
}

/**
 * 从会话事件里筛出用于连播的鼾声片段：只保留 type === 'snore'，
 * 按开始时间升序。返回的元素与原数组共享引用（UI 用同一对象做高亮匹配）。
 */
export function selectSnoreClips(events: readonly SoundEvent[]): SoundEvent[] {
  return events
    .filter((e) => e.type === 'snore')
    .slice()
    .sort((a, b) => a.start - b.start);
}
