/**
 * 监测状态机与统计聚合（纯 reducer，不依赖 React）。
 *
 * 原先 App.tsx 用 isMonitoring / isBusy / monitoringRef / startInFlightRef /
 * stopInFlightRef 手工拼启停锁，并用 5 个计数 state + totalsRef + eventsRef
 * 各自维护一份统计。这里收敛为单一状态：phase 决定启停，events 是事件表的
 * 唯一来源，counts / totalsMs 由事件累加得出。
 */
import type { SleepSession, SoundEvent, SoundEventType } from '../types';

/** 单次会话事件数上限，防止 AsyncStorage 溢出 */
export const MAX_EVENTS_PER_SESSION = 1000;

export type MonitorPhase = 'idle' | 'starting' | 'monitoring' | 'stopping';

export interface MonitorCounts {
  snore: number;
  grind: number;
  talk: number;
  apnea: number;
}

export interface MonitorTotalsMs {
  snore: number;
  grind: number;
  talk: number;
  apnea: number;
}

export interface MonitorState {
  /** 启停状态机：idle → starting → monitoring → stopping → idle */
  phase: MonitorPhase;
  /** 历史会话列表（唯一真相源，异步回调通过 App 内的只读 ref 读取） */
  sessions: SleepSession[];
  /** 本次监测的事件表（唯一真相源） */
  events: SoundEvent[];
  counts: MonitorCounts;
  totalsMs: MonitorTotalsMs;
  /** 进行中事件的累计时长：UI 的「声音总时长」需要把它算进去 */
  ongoingMs: number;
  eventsTruncated: boolean;
}

export type MonitorAction =
  | { type: 'start/begin' }
  | { type: 'start/session-reset' }
  | { type: 'start/failed' }
  | { type: 'start/succeeded' }
  | { type: 'stop/begin' }
  | { type: 'stop/finish' }
  | { type: 'frame/event'; event: SoundEvent }
  | { type: 'frame/replace-events'; events: SoundEvent[] }
  | { type: 'frame/ongoing'; ms: number }
  | { type: 'sessions/set'; sessions: SleepSession[] };

export const initialMonitorState: MonitorState = {
  phase: 'idle',
  sessions: [],
  events: [],
  counts: { snore: 0, grind: 0, talk: 0, apnea: 0 },
  totalsMs: { snore: 0, grind: 0, talk: 0, apnea: 0 },
  ongoingMs: 0,
  eventsTruncated: false,
};

const EMPTY_COUNTS: MonitorCounts = { snore: 0, grind: 0, talk: 0, apnea: 0 };
const EMPTY_TOTALS: MonitorTotalsMs = { snore: 0, grind: 0, talk: 0, apnea: 0 };

const isCollecting = (phase: MonitorPhase) => phase === 'starting' || phase === 'monitoring';

export function monitorReducer(state: MonitorState, action: MonitorAction): MonitorState {
  switch (action.type) {
    // 防重入：非 idle 时重复 start 直接忽略，不会产生第二次原生启动
    case 'start/begin':
      if (state.phase !== 'idle') return state;
      return { ...state, phase: 'starting' };

    // 原生/兼容录音已拉起，事件表与统计清零后再进入监测
    case 'start/session-reset':
      if (!isCollecting(state.phase)) return state;
      return {
        ...state,
        events: [],
        counts: { ...EMPTY_COUNTS },
        totalsMs: { ...EMPTY_TOTALS },
        ongoingMs: 0,
        eventsTruncated: false,
      };

    case 'start/failed':
      if (state.phase !== 'starting') return state;
      return {
        ...state,
        phase: 'idle',
        events: [],
        counts: { ...EMPTY_COUNTS },
        totalsMs: { ...EMPTY_TOTALS },
        ongoingMs: 0,
        eventsTruncated: false,
      };

    case 'start/succeeded':
      if (state.phase !== 'starting') return state;
      return { ...state, phase: 'monitoring' };

    // 防重入：只有 monitoring 才能停止，重复 stop 被忽略，不会双结算
    case 'stop/begin':
      if (state.phase !== 'monitoring') return state;
      return { ...state, phase: 'stopping' };

    case 'stop/finish':
      if (state.phase !== 'stopping') return state;
      return {
        ...state,
        phase: 'idle',
        events: [],
        counts: { ...EMPTY_COUNTS },
        totalsMs: { ...EMPTY_TOTALS },
        ongoingMs: 0,
        eventsTruncated: false,
      };

    case 'frame/event': {
      // stopping 阶段仍接受：stop 里 detector.flush() 收尾的最后一条事件必须进表
      if (state.phase === 'idle') return state;
      if (state.events.length >= MAX_EVENTS_PER_SESSION) {
        if (state.eventsTruncated) return state;
        return { ...state, eventsTruncated: true };
      }
      const type: SoundEventType = action.event.type;
      return {
        ...state,
        events: [...state.events, action.event],
        counts: { ...state.counts, [type]: state.counts[type] + 1 },
        totalsMs: { ...state.totalsMs, [type]: state.totalsMs[type] + action.event.duration },
      };
    }

    case 'frame/replace-events':
      // 裁剪后回填 playStart 发生在 stopping 阶段，不能按 idle 丢弃
      if (state.phase === 'idle') return state;
      return { ...state, events: action.events };

    case 'frame/ongoing':
      if (!isCollecting(state.phase)) return state;
      if (state.ongoingMs === action.ms) return state;
      return { ...state, ongoingMs: action.ms };

    case 'sessions/set':
      return { ...state, sessions: action.sessions };

    default:
      return state;
  }
}
