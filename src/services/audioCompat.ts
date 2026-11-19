/**
 * expo-av 兼容层（Expo SDK 58 迁移用）。
 *
 * 背景：expo-av 在 SDK 58 下已不再可用 —— 它的 Android 产物（expo-av 16.x）仍是
 * SDK 52 时代的 expo-modules-core 接口，release 构建在 R8 阶段会报
 * `Missing class expo.modules.kotlin.types.AnyTypeProvider` 等错误，直接失败。
 *
 * 这个 App 只用到 expo-av 的三件事：
 *   1) 播放裁剪出来的片段（Audio.Sound）；
 *   2) 兼容模式（iOS / 原生模块启动失败）下的 m4a 录音 + metering（Audio.Recording）；
 *   3) 权限查询与音频模式设置。
 *
 * expo-audio 提供了等价能力（createAudioPlayer / AudioRecorder / setAudioModeAsync），
 * 但接口形状不同。这里把它包成 expo-av 的形状，App.tsx 只换 import 而不改调用逻辑，
 * 迁移风险最小。
 */

import {
  createAudioPlayer,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync as setAudioMode,
  type AudioPlayer,
  type AudioRecorder,
  type AudioStatus,
  type RecorderState,
} from 'expo-audio';
// expo-audio 的公共入口只导出 AudioRecorder 类型，构造实例要走原生模块本身
import ExpoAudioModule from 'expo-audio/build/AudioModule';

/** expo-av 的播放状态形状（App 里只读这几个字段） */
export type PlaybackStatus = {
  isLoaded: boolean;
  isPlaying: boolean;
  shouldPlay: boolean;
  positionMillis: number;
  durationMillis: number;
  didJustFinish: boolean;
};

export type RecordingStatus = {
  isRecording: boolean;
  isDoneRecording: boolean;
  metering?: number;
  durationMillis: number;
};

/** App 里传的是 expo-av 的完整选项对象；这里只取真正会用到的字段 */
export type RecordingOptions = {
  isMeteringEnabled?: boolean;
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
  extension?: string;
  [key: string]: unknown;
};

const toPlaybackStatus = (s: AudioStatus): PlaybackStatus => ({
  isLoaded: s.isLoaded,
  isPlaying: s.playing,
  shouldPlay: s.playing,
  positionMillis: Math.max(0, Math.round((s.currentTime || 0) * 1000)),
  durationMillis: Math.max(0, Math.round((s.duration || 0) * 1000)),
  didJustFinish: s.didJustFinish,
});

/** 等价于 expo-av 的 Audio.Sound */
export class Sound {
  private player: AudioPlayer;
  private subscription: { remove: () => void } | null = null;
  private detached = false;

  private constructor(player: AudioPlayer) {
    this.player = player;
  }

  static async createAsync(source: { uri: string }): Promise<{ sound: Sound }> {
    const player = createAudioPlayer({ uri: source.uri }, { updateInterval: 100 });
    return { sound: new Sound(player) };
  }

  setOnPlaybackStatusUpdate(cb: ((status: PlaybackStatus) => void) | null): void {
    this.subscription?.remove();
    this.subscription = null;
    if (!cb || this.detached) return;
    this.subscription = this.player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      cb(toPlaybackStatus(s));
    });
    // expo-audio 只在状态变化时推送；先补一次当前快照，避免 UI 拿不到时长。
    if (this.player.isLoaded) cb(toPlaybackStatus(this.player.currentStatus));
  }

  async playAsync(): Promise<void> {
    this.player.play();
  }

  async pauseAsync(): Promise<void> {
    this.player.pause();
  }

  async stopAsync(): Promise<void> {
    this.player.pause();
    try {
      await this.player.seekTo(0);
    } catch {
      // 文件已释放/未就绪时定位会失败，忽略即可
    }
  }

  async setStatusAsync(opts: { positionMillis?: number; shouldPlay?: boolean }): Promise<void> {
    if (typeof opts.positionMillis === 'number') {
      await this.player.seekTo(opts.positionMillis / 1000);
    }
    if (opts.shouldPlay) this.player.play();
  }

  async getStatusAsync(): Promise<PlaybackStatus> {
    return toPlaybackStatus(this.player.currentStatus);
  }

  async unloadAsync(): Promise<void> {
    this.detached = true;
    this.subscription?.remove();
    this.subscription = null;
    this.player.remove();
  }
}

/** 等价于 expo-av 的 Audio.Recording */
export class Recording {
  private recorder: AudioRecorder;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private constructor(recorder: AudioRecorder) {
    this.recorder = recorder;
  }

  static async createAsync(
    options: RecordingOptions,
    onStatus?: (status: RecordingStatus) => void,
    intervalMs = 300
  ): Promise<{ recording: Recording }> {
    const recorder = new (ExpoAudioModule.AudioRecorder as unknown as new (
      options: Record<string, unknown>
    ) => AudioRecorder)({
      extension: options.extension ?? '.m4a',
      sampleRate: options.sampleRate ?? 44100,
      numberOfChannels: options.numberOfChannels ?? 1,
      bitRate: options.bitRate ?? 64000,
      // 兼容模式靠 metering 驱动音量条与沉默判定，必须开
      isMeteringEnabled: options.isMeteringEnabled ?? true,
    });
    await recorder.prepareToRecordAsync();
    recorder.record();

    const instance = new Recording(recorder);
    if (onStatus) instance.startPolling(onStatus, intervalMs);
    return { recording: instance };
  }

  private startPolling(onStatus: (status: RecordingStatus) => void, intervalMs: number): void {
    const tick = () => {
      if (this.stopped) return;
      let state: RecorderState | null = null;
      try {
        state = this.recorder.getStatus();
      } catch {
        return;
      }
      if (!state) return;
      onStatus({
        isRecording: state.isRecording,
        isDoneRecording: false,
        metering: typeof state.metering === 'number' ? state.metering : undefined,
        durationMillis: state.durationMillis ?? 0,
      });
    };
    tick();
    this.timer = setInterval(tick, Math.max(100, intervalMs));
  }

  getURI(): string | null {
    return this.recorder.uri ?? null;
  }

  async stopAndUnloadAsync(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.recorder.stop();
    } catch (e) {
      // 录音机可能已被系统回收（来电/被其他 App 抢占），此时保留已写入的文件即可
      console.warn('停止录音时出错', e);
    }
  }
}

/** expo-av 的枚举在 expo-audio 里不存在；调用方只是把值塞进选项对象，给等价占位值即可 */
const AndroidOutputFormat = { DEFAULT: 0, THREE_GPP: 1, MPEG_4: 2, AMR_NB: 3, AMR_WB: 4, AAC_ADTS: 6 };
const AndroidAudioEncoder = { DEFAULT: 0, AAC: 1, AMR_NB: 2, AMR_WB: 3, HE_AAC: 4 };
const IOSOutputFormat = { MPEG4AAC: 'aac ', LINEARPCM: 'lpcm' };
const IOSAudioQuality = { MIN: 0, LOW: 0.25, MEDIUM: 0.5, HIGH: 0.75, MAX: 1 };

export const InterruptionModeIOS = { MixWithOthers: 'mixWithOthers', DoNotMix: 'doNotMix', DuckOthers: 'duckOthers' } as const;
export const InterruptionModeAndroid = { DuckOthers: 'duckOthers', DoNotMix: 'doNotMix', MixWithOthers: 'mixWithOthers' } as const;

type LegacyAudioMode = {
  allowsRecordingIOS?: boolean;
  playsInSilentModeIOS?: boolean;
  staysActiveInBackground?: boolean;
  interruptionModeIOS?: string;
  interruptionModeAndroid?: string;
  shouldDuckAndroid?: boolean;
  playThroughEarpieceAndroid?: boolean;
};

export const Audio = {
  Sound,
  Recording,
  AndroidOutputFormat,
  AndroidAudioEncoder,
  IOSOutputFormat,
  IOSAudioQuality,

  async getPermissionsAsync() {
    return getRecordingPermissionsAsync();
  },

  async requestPermissionsAsync() {
    return requestRecordingPermissionsAsync();
  },

  /** expo-av 的音频模式字段名与 expo-audio 不同，这里做映射 */
  async setAudioModeAsync(mode: LegacyAudioMode) {
    const interruptionMode =
      mode.interruptionModeIOS === 'mixWithOthers' || mode.interruptionModeAndroid === 'mixWithOthers'
        ? 'mixWithOthers'
        : mode.shouldDuckAndroid || mode.interruptionModeAndroid === 'duckOthers'
          ? 'duckOthers'
          : 'doNotMix';
    await setAudioMode({
      allowsRecording: mode.allowsRecordingIOS ?? true,
      playsInSilentMode: mode.playsInSilentModeIOS ?? true,
      // 原生路径靠前台服务保活；兼容模式还要靠它让录音在锁屏后继续
      shouldPlayInBackground: mode.staysActiveInBackground ?? true,
      allowsBackgroundRecording: mode.staysActiveInBackground ?? true,
      interruptionMode: interruptionMode as 'mixWithOthers' | 'doNotMix' | 'duckOthers',
      interruptionModeAndroid: (mode.interruptionModeAndroid === 'duckOthers'
        ? 'duckOthers'
        : mode.interruptionModeAndroid === 'mixWithOthers'
          ? 'mixWithOthers'
          : 'doNotMix') as 'duckOthers' | 'doNotMix' | 'mixWithOthers',
      shouldRouteThroughEarpiece: mode.playThroughEarpieceAndroid ?? false,
    });
  },
};
