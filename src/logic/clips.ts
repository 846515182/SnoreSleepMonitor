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
  // 裁剪过的鼾声文件：位置已经按片段排好，前后留白在裁剪时就加进去了，
  // 不能再往外扩，否则会串到下一段鼾声里。
  if (typeof evt.playStart === 'number') {
    const start = Math.max(0, evt.playStart);
    const end = typeof evt.playEnd === 'number' && evt.playEnd > start ? evt.playEnd : start + 1000;
    return { start, end };
  }
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

/** 鼾声片段最多保留的总时长：45 分钟（16kHz 单声道约 86MB） */
export const MAX_SNORE_AUDIO_MS = 45 * 60 * 1000;

/** 两段鼾声离得比这还近就并成一段，免得片段之间夹一堆静音 */
export const CLIP_MERGE_GAP_MS = 400;

export interface SnoreAudioPlan {
  /** 要从原录音里拷出来的区间（毫秒，升序、互不重叠） */
  ranges: { start: number; end: number }[];
  /** 与传入的 events 下标对齐；-1 表示这条事件没有对应音频 */
  offsets: number[];
  /** 裁剪后文件的总时长 */
  totalMs: number;
}

/**
 * 计划「只保留鼾声」的裁剪区间。
 *
 * 原录音是整晚的（含大量安静时段），用户只想留打呼噜的声音：
 * 把每个鼾声事件前后各留一点上下文，合并挨得太近的段，再按上限截断。
 * 返回的 offsets 用来把事件映射到新文件里的位置，回放时直接跳过去。
 */
export function planSnoreAudio(
  events: readonly SoundEvent[],
  maxTotalMs: number = MAX_SNORE_AUDIO_MS
): SnoreAudioPlan {
  const snoreIdx: number[] = [];
  events.forEach((e, i) => {
    if (e.type === 'snore') snoreIdx.push(i);
  });
  snoreIdx.sort((a, b) => events[a].start - events[b].start);

  const ranges: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  let total = 0;

  const pushCur = () => {
    if (!cur) return;
    let len = cur.end - cur.start;
    if (total + len > maxTotalMs) len = Math.max(0, maxTotalMs - total);
    if (len > 0) {
      ranges.push({ start: cur.start, end: cur.start + len });
      total += len;
    }
    cur = null;
  };

  for (const i of snoreIdx) {
    if (total >= maxTotalMs) break;
    const ev = events[i];
    const s = Math.max(0, Math.round(ev.start - CLIP_PAD_BEFORE_MS));
    const e = Math.max(s + 1, Math.round(ev.end + CLIP_PAD_AFTER_MS));
    if (cur && s <= cur.end + CLIP_MERGE_GAP_MS) {
      cur.end = Math.max(cur.end, e);
    } else {
      pushCur();
      if (total >= maxTotalMs) break;
      cur = { start: s, end: e };
    }
  }
  pushCur();

  const offsets: number[] = new Array(events.length).fill(-1);
  let base = 0;
  for (let k = 0; k < ranges.length; k++) {
    const r = ranges[k];
    for (const i of snoreIdx) {
      const ev = events[i];
      if (ev.start >= r.start && ev.start < r.end) {
        offsets[i] = base + (ev.start - r.start);
      }
    }
    base += r.end - r.start;
  }

  return { ranges, offsets, totalMs: total };
}