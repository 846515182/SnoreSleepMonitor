import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
  NativeModules,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform,
  PermissionsAndroid,
  ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

// 原生音频模块（Android 专用，用 MediaRecorder.getMaxAmplitude 获取实时音量）
const AudioMeter = NativeModules.AudioMeter;

// 类型定义
interface SoundEvent {
  start: number; // 相对会话开始的毫秒数
  end: number;
  duration: number; // 毫秒
  type: 'snore' | 'grind'; // 打鼾 | 磨牙
}

interface SleepSession {
  id: string;
  startTime: number;
  endTime?: number;
  durationSeconds: number;
  events: SoundEvent[];
  snoreCount: number;
  grindCount: number;
  totalSnoreSeconds: number;
  totalGrindSeconds: number;
  recordingUri?: string;
  qualityScore: number; // 0-100
}

type Screen = 'home' | 'history' | 'detail' | 'settings';

// 常量
const STORAGE_KEY = '@snore_sessions_v2';
const SETTINGS_KEY = '@snore_settings_v2';
const CHUNK_MS = 300; // 监测循环周期（更频繁采样）
const DEFAULT_SNORE_CONFIDENCE = 0.5; // 默认鼾声置信度阈值（50%）
const DEFAULT_GRIND_CONFIDENCE = 0.35; // 默认磨牙启发式阈值（响度比例）
const FALLBACK_THRESHOLD_DB = -60; // expo-av 回退方案音量阈值
const MIN_SNORE_MS = 500; // 最小打鼾持续时间 0.5 秒即可
const MIN_GRIND_MS = 300; // 最小磨牙持续时间 0.3 秒
const MAX_GRIND_MS = 1500; // 磨牙事件一般不超过 1.5 秒
const GRIND_LOUD_DB = -42; // 启发式磨牙检测的最小响度
const GRACE_MS = 700; // 静音宽限期：小于此值的静音不结束事件
const COOLDOWN_MS = 500; // 事件冷却间隔缩短

// 辅助函数
function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function calculateQualityScore(sleepSeconds: number, noiseSeconds: number): number {
  if (sleepSeconds <= 0) return 100;
  // Clamp ratio to [0, 1]; if more than half the night is noisy, score trends toward 0.
  const ratio = Math.min(1, noiseSeconds / sleepSeconds);
  // Smooth exponential decay: 5% noise -> ~91, 15% -> ~75, 30% -> ~53, 50% -> ~29.
  const score = 100 * Math.pow(1 - ratio, 1.8);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [selectedSession, setSelectedSession] = useState<SleepSession | null>(null);
  const [sessions, setSessions] = useState<SleepSession[]>([]);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [volumeDb, setVolumeDb] = useState(-100);
  const [maxVolumeDb, setMaxVolumeDb] = useState(-100);
  const [snoreThreshold, setSnoreThreshold] = useState(DEFAULT_SNORE_CONFIDENCE);
  const [grindThreshold, setGrindThreshold] = useState(DEFAULT_GRIND_CONFIDENCE);
  const [snoreConfidence, setSnoreConfidence] = useState(0);
  const [topClass, setTopClass] = useState('noise');
  const [topConfidence, setTopConfidence] = useState(0);
  const [confidences, setConfidences] = useState<Record<string, number>>({});
  const [isSnoringNow, setIsSnoringNow] = useState(false);
  const [sleepStartTime, setSleepStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [snoreCount, setSnoreCount] = useState(0);
  const [grindCount, setGrindCount] = useState(0);
  const [totalNoiseSeconds, setTotalNoiseSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosMs, setPlaybackPosMs] = useState(0); // 当前播放位置（毫秒）
  const [playbackDurMs, setPlaybackDurMs] = useState(0); // 录音总时长（毫秒）
  const [isReady, setIsReady] = useState(false);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingUriRef = useRef<string>('');
  const useNativeMeterRef = useRef<boolean>(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const monitorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventsRef = useRef<SoundEvent[]>([]);
  const currentEventRef = useRef<SoundEvent | null>(null);
  const currentSnoreFramesRef = useRef<number>(0);
  const currentTotalFramesRef = useRef<number>(0);
  const lastEventEndRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const lastMeteringRef = useRef<number>(-100); // expo-av 回调方式的最新 metering 值

  // 加载设置与历史
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const settingsRaw = await AsyncStorage.getItem(SETTINGS_KEY);
        if (settingsRaw) {
          const settings = JSON.parse(settingsRaw);
          if (typeof settings.snoreThreshold === 'number' && mounted) {
            setSnoreThreshold(Math.max(0.1, Math.min(0.9, settings.snoreThreshold)));
          }
          if (typeof settings.grindThreshold === 'number' && mounted) {
            setGrindThreshold(Math.max(0.1, Math.min(0.9, settings.grindThreshold)));
          }
        }
      } catch (e) {
        console.warn('加载设置失败', e);
      }
      await loadSessions();
      const permitted = await checkPermission();
      if (mounted) {
        setHasPermission(permitted);
        setIsReady(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const loadSessions = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: SleepSession[] = JSON.parse(raw);
        parsed.sort((a, b) => b.startTime - a.startTime);
        setSessions(parsed);
      }
    } catch (e) {
      console.warn('加载历史失败', e);
    }
  };

  const saveSettings = async (nextSnore: number, nextGrind: number) => {
    try {
      await AsyncStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ snoreThreshold: nextSnore, grindThreshold: nextGrind })
      );
    } catch (e) {
      console.warn('保存设置失败', e);
    }
  };

  const checkPermission = async (): Promise<boolean> => {
    try {
      if (Platform.OS === 'android') {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO!,
          {
            title: '需要录音权限',
            message: '睡眠监测需要访问麦克风以录制鼾声、磨牙等声音。',
            buttonNeutral: '稍后询问',
            buttonNegative: '取消',
            buttonPositive: '允许',
          }
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const { status } = await Audio.requestPermissionsAsync();
        return status === 'granted';
      }
    } catch (e) {
      console.error('权限检查失败', e);
      return false;
    }
  };

  const setupAudioMode = async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
    } catch (e) {
      console.warn('设置音频模式失败', e);
    }
  };

  const startMonitoring = async () => {
    if (isBusy || isMonitoring) return;
    setIsBusy(true);
    const permitted = await checkPermission();
    setHasPermission(permitted);
    if (!permitted) {
      Alert.alert('需要麦克风权限', '请在系统设置中允许本应用使用麦克风，否则无法录音。');
      setIsBusy(false);
      return;
    }

    try {
      await setupAudioMode();

      // 优先使用原生 AudioMeter 模块（Android），回退到 expo-av
      if (Platform.OS === 'android' && AudioMeter) {
        // 原生模块：用 MediaRecorder 录音 + getMaxAmplitude 获取音量
        const recordingUri = await AudioMeter.startRecording();
        recordingUriRef.current = recordingUri;
        useNativeMeterRef.current = true;
      } else {
        useNativeMeterRef.current = false;
        lastMeteringRef.current = -100;
        // expo-av 回退方案：用 onRecordingStatusUpdate 回调获取 metering（比 getStatusAsync 更可靠）
        const recordingOptions: Audio.RecordingOptions = {
          isMeteringEnabled: true,
          android: {
            extension: '.m4a',
            outputFormat: Audio.AndroidOutputFormat.MPEG_4,
            audioEncoder: Audio.AndroidAudioEncoder.AAC,
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 64000,
          },
          ios: {
            extension: '.m4a',
            outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
            audioQuality: Audio.IOSAudioQuality.HIGH,
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 64000,
            linearPCMBitDepth: 16,
            linearPCMIsBigEndian: false,
            linearPCMIsFloat: false,
          },
          web: {
            mimeType: 'audio/webm',
            bitsPerSecond: 64000,
          },
        };
        const { recording } = await Audio.Recording.createAsync(
          recordingOptions,
          (status) => {
            // onRecordingStatusUpdate 回调：比 getStatusAsync 更可靠地获取 metering
            if (status.isRecording && typeof (status as any).metering === 'number') {
              lastMeteringRef.current = (status as any).metering;
            }
          },
          CHUNK_MS,
        );
        recordingRef.current = recording;
      }

      startTimeRef.current = Date.now();
      setSleepStartTime(startTimeRef.current);
      setElapsedSeconds(0);
      setSnoreCount(0);
      setGrindCount(0);
      setTotalNoiseSeconds(0);
      setIsMonitoring(true);
      setVolumeDb(-100);
      setSnoreConfidence(0);
      setTopClass('noise');
      setTopConfidence(0);
      setConfidences({});
      eventsRef.current = [];
      currentEventRef.current = null;
      currentSnoreFramesRef.current = 0;
      currentTotalFramesRef.current = 0;
      lastEventEndRef.current = 0;
      lastLoudTimeRef.current = 0;
      maxVolumeDbRef.current = -100;
      setMaxVolumeDb(-100);

      // 用递归 setTimeout 替代 setInterval，避免 async monitorLoop 调用重叠
      const runLoop = async () => {
        await monitorLoop();
        if (monitorTimerRef.current !== null) {
          monitorTimerRef.current = setTimeout(runLoop, CHUNK_MS);
        }
      };
      monitorTimerRef.current = setTimeout(runLoop, CHUNK_MS);
    } catch (e) {
      console.error('开始录音失败', e);
      Alert.alert('启动失败', String(e));
      setIsMonitoring(false);
    } finally {
      setIsBusy(false);
    }
  };

  const lastLoudTimeRef = useRef<number>(0); // 最后一次响亮的时间
  const maxVolumeDbRef = useRef<number>(-100); // 本次监测最大音量

  const monitorLoop = async () => {
    // 原生模块路径：使用 TFLite 鼾声检测模型
    if (useNativeMeterRef.current && AudioMeter) {
      try {
        const result = await AudioMeter.getLatestResult();
        const metering = typeof result.amplitudeDb === 'number' ? result.amplitudeDb : -100;
        const sConf = typeof result.snoreConfidence === 'number' ? result.snoreConfidence : 0;
        const tClass = typeof result.topClass === 'string' ? result.topClass : 'noise';
        const tConf = typeof result.topConfidence === 'number' ? result.topConfidence : 0;
        const confs: Record<string, number> = result.confidences || {};
        setVolumeDb(metering);
        setSnoreConfidence(sConf);
        setTopClass(tClass);
        setTopConfidence(tConf);
        setConfidences(confs);
        if (metering > maxVolumeDbRef.current) {
          maxVolumeDbRef.current = metering;
          setMaxVolumeDb(metering);
        }

        const now = Date.now();
        const sessionElapsed = now - startTimeRef.current;
        setElapsedSeconds(Math.floor(sessionElapsed / 1000));

        // Native has already applied a 0.5 internal threshold for isSnoring.
        // JS applies the user-defined snoreThreshold on top to control sensitivity.
        const isSnoreFrame = !!result.isSnoring && sConf >= snoreThreshold;
        // Heuristic grind frame: loud enough, not snoring, and snore confidence is well below threshold.
        const isGrindFrame =
          !isSnoreFrame && metering >= GRIND_LOUD_DB && sConf < snoreThreshold * (1 - grindThreshold);
        setIsSnoringNow(isSnoreFrame || isGrindFrame);
        detectEvent(isSnoreFrame, isGrindFrame, sessionElapsed);
      } catch (e) {
        console.warn('原生监测循环异常', e);
      }
      return;
    }

    // expo-av 回退路径：从 onRecordingStatusUpdate 回调读取最新 metering
    const metering = lastMeteringRef.current;
    setVolumeDb(metering);
    setSnoreConfidence(0);
    setTopClass('noise');
    setTopConfidence(0);
    setConfidences({});
    if (metering > maxVolumeDbRef.current) {
      maxVolumeDbRef.current = metering;
      setMaxVolumeDb(metering);
    }

    const now = Date.now();
    const sessionElapsed = now - startTimeRef.current;
    setElapsedSeconds(Math.floor(sessionElapsed / 1000));

    // Fallback path has no TFLite model, so all loud events are treated as snores.
    const isLoud = metering >= FALLBACK_THRESHOLD_DB;
    setIsSnoringNow(isLoud);
    detectEvent(isLoud, false, sessionElapsed);
  };

  // 事件检测：按帧标记为鼾声/磨牙/静音，事件结束时根据帧比例与持续时间分类。
  // 当前 TFLite 模型只有 noise/snoring 两类，因此磨牙是通过“短时、响亮、非鼾声”的启发式规则推断的。
  const detectEvent = (isSnoreFrame: boolean, isGrindFrame: boolean, sessionElapsed: number) => {
    const isLoud = isSnoreFrame || isGrindFrame;

    if (isLoud) {
      lastLoudTimeRef.current = sessionElapsed;
      if (!currentEventRef.current) {
        currentEventRef.current = {
          start: sessionElapsed,
          end: sessionElapsed,
          duration: 0,
          type: isSnoreFrame ? 'snore' : 'grind',
        };
        currentSnoreFramesRef.current = isSnoreFrame ? 1 : 0;
        currentTotalFramesRef.current = 1;
      } else {
        currentEventRef.current.end = sessionElapsed;
        currentEventRef.current.duration = sessionElapsed - currentEventRef.current.start;
        currentTotalFramesRef.current += 1;
        if (isSnoreFrame) currentSnoreFramesRef.current += 1;
      }
    } else {
      // 静音时，只有超过宽限期才结束当前事件
      const silenceDuration = sessionElapsed - lastLoudTimeRef.current;
      if (silenceDuration >= GRACE_MS) {
        finalizeCurrentEvent();
      }
    }

    const finished = eventsRef.current.reduce((sum, e) => sum + e.duration, 0);
    const ongoing = currentEventRef.current ? currentEventRef.current.duration : 0;
    setTotalNoiseSeconds(Math.floor((finished + ongoing) / 1000));
  };

  const finalizeCurrentEvent = () => {
    const evt = currentEventRef.current;
    if (!evt) return;

    const duration = evt.end - evt.start;
    const snoreRatio =
      currentTotalFramesRef.current > 0
        ? currentSnoreFramesRef.current / currentTotalFramesRef.current
        : 0;

    let type: 'snore' | 'grind' = 'snore';
    let valid = false;

    if (snoreRatio >= 0.5 && duration >= MIN_SNORE_MS) {
      type = 'snore';
      valid = true;
    } else if (duration >= MIN_GRIND_MS && duration <= MAX_GRIND_MS && snoreRatio < 0.35) {
      type = 'grind';
      valid = true;
    }

    if (valid) {
      evt.type = type;
      eventsRef.current.push({ ...evt });
      if (type === 'snore') setSnoreCount((c) => c + 1);
      else setGrindCount((c) => c + 1);
      lastEventEndRef.current = evt.end;
    }

    currentEventRef.current = null;
    currentSnoreFramesRef.current = 0;
    currentTotalFramesRef.current = 0;
  };

  const stopMonitoring = async () => {
    if (isBusy || !isMonitoring) return;
    setIsBusy(true);
    if (monitorTimerRef.current) {
      clearTimeout(monitorTimerRef.current);
      monitorTimerRef.current = null;
    }

    let uri: string | undefined;

    // 原生模块停止
    if (useNativeMeterRef.current && AudioMeter) {
      try {
        uri = await AudioMeter.stopRecording();
      } catch (e) {
        console.error('原生停止录音失败', e);
      }
    } else {
      // expo-av 停止
      const recording = recordingRef.current;
      if (recording) {
        try {
          await recording.stopAndUnloadAsync();
          uri = recording.getURI() ?? undefined;
        } catch (e) {
          console.error('停止录音失败', e);
        } finally {
          recordingRef.current = null;
        }
      }
    }

    try {
      const endTime = Date.now();
      const durationSeconds = Math.max(1, Math.floor((endTime - startTimeRef.current) / 1000));

      // 收尾当前事件
      finalizeCurrentEvent();

      const snoreEvents = eventsRef.current.filter((e) => e.type === 'snore');
      const grindEvents = eventsRef.current.filter((e) => e.type === 'grind');
      const totalSnoreMs = snoreEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalGrindMs = grindEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalNoiseSec = Math.floor((totalSnoreMs + totalGrindMs) / 1000);

      const session: SleepSession = {
        id: `${startTimeRef.current}`,
        startTime: startTimeRef.current,
        endTime,
        durationSeconds,
        events: eventsRef.current,
        snoreCount: snoreEvents.length,
        grindCount: grindEvents.length,
        totalSnoreSeconds: Math.floor(totalSnoreMs / 1000),
        totalGrindSeconds: Math.floor(totalGrindMs / 1000),
        recordingUri: uri,
        qualityScore: calculateQualityScore(durationSeconds, totalNoiseSec),
      };

      const updated = [session, ...sessions];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setSessions(updated);
    } catch (e) {
      console.error('保存会话失败', e);
      Alert.alert('保存失败', String(e));
    }

    useNativeMeterRef.current = false;
    recordingUriRef.current = '';
    setIsMonitoring(false);
    setIsBusy(false);
    setVolumeDb(-100);
    setSnoreConfidence(0);
    setTopClass('noise');
    setTopConfidence(0);
    setConfidences({});
    setIsSnoringNow(false);
  };

  const deleteSession = async (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (session?.recordingUri) {
      try {
        await FileSystem.deleteAsync(session.recordingUri, { idempotent: true });
      } catch (e) {
        console.warn('删除录音失败', e);
      }
    }
    const updated = sessions.filter((s) => s.id !== id);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setSessions(updated);
  };

  const playRecording = async (uri: string, startMs?: number) => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;
      setIsPlaying(true);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        setPlaybackPosMs(status.positionMillis || 0);
        setPlaybackDurMs(status.durationMillis || 0);
        if (status.didJustFinish) {
          setIsPlaying(false);
          setPlaybackPosMs(0);
        }
      });
      // 跳转到指定起始位置后播放
      if (startMs && startMs > 0) {
        await sound.setStatusAsync({ positionMillis: startMs, shouldPlay: true });
      } else {
        await sound.playAsync();
      }
    } catch (e) {
      console.error('播放失败', e);
      Alert.alert('播放失败', String(e));
    }
  };

  // 跳转到事件时间点播放
  const seekToEvent = async (evt: SoundEvent) => {
    if (!selectedSession?.recordingUri) return;
    // 若已加载同一录音，直接 seek；否则重新加载
    if (soundRef.current) {
      try {
        await soundRef.current.setStatusAsync({ positionMillis: evt.start, shouldPlay: true });
        setIsPlaying(true);
        return;
      } catch (e) {
        console.warn('跳转失败，重新加载', e);
      }
    }
    await playRecording(selectedSession.recordingUri, evt.start);
  };

  const stopPlayback = async () => {
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      setIsPlaying(false);
      setPlaybackPosMs(0);
    }
  };

  useEffect(() => {
    return () => {
      if (monitorTimerRef.current) clearTimeout(monitorTimerRef.current);
      if (useNativeMeterRef.current && AudioMeter) {
        AudioMeter.stopRecording().catch(() => {});
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  if (!isReady) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color="#4ECDC4" />
        <Text style={styles.loadingText}>正在初始化…</Text>
      </SafeAreaView>
    );
  }

  // UI 渲染
  const renderHome = () => (
    <ScrollView contentContainerStyle={styles.homeContent}>
      <View style={styles.card}>
        <Text style={styles.title}>睡眠监测</Text>
        <Text style={styles.subtitle}>记录打鼾、磨牙与整晚录音</Text>

        {hasPermission === false && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>未获得麦克风权限，无法录音。</Text>
            <Button title="去授权" onPress={async () => setHasPermission(await checkPermission())} />
          </View>
        )}

        <View style={styles.timerBox}>
          <Text style={styles.timerLabel}>本次睡眠</Text>
          <Text style={styles.timerValue}>{formatDuration(elapsedSeconds)}</Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{snoreCount}</Text>
            <Text style={styles.statLabel}>打鼾次数</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{grindCount}</Text>
            <Text style={styles.statLabel}>磨牙次数</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{formatDuration(totalNoiseSeconds)}</Text>
            <Text style={styles.statLabel}>异常声音时长</Text>
          </View>
        </View>

        <View style={styles.volumeBox}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.volumeLabel}>实时音量</Text>
            <Text style={styles.volumeThreshold}>鼾声阈值 {(snoreThreshold * 100).toFixed(0)}%</Text>
          </View>
          <View style={styles.volumeBarBg}>
            <View
              style={[
                styles.volumeBarFill,
                {
                  width: `${Math.min(100, Math.max(0, (volumeDb + 80) / 80 * 100))}%`,
                  backgroundColor: isSnoringNow ? '#FF6B6B' : '#4ECDC4',
                },
              ]}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={styles.volumeDb}>{volumeDb.toFixed(1)} dB</Text>
            <Text style={[styles.volumeDb, { color: isSnoringNow ? '#FF6B6B' : '#7A8B9C', fontWeight: isSnoringNow ? '700' : '400' }]}>
              {isSnoringNow ? '● 检测到声音' : '○ 安静'}
            </Text>
          </View>
          <Text style={[styles.volumeDb, { color: '#FFD93D', marginTop: 4 }]}>
            本次最大音量: {maxVolumeDb > -100 ? maxVolumeDb.toFixed(1) + ' dB' : '--'}
          </Text>
          <Text style={[styles.volumeDb, { color: '#4ECDC4', marginTop: 4 }]}>
            模型结果: {topClass} {(topConfidence * 100).toFixed(1)}% · 鼾声置信度 {(snoreConfidence * 100).toFixed(1)}%
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.mainButton,
            isMonitoring ? styles.stopButton : styles.startButton,
            isBusy && { opacity: 0.7 },
          ]}
          onPress={isMonitoring ? stopMonitoring : startMonitoring}
          activeOpacity={0.8}
          disabled={isBusy}
        >
          {isBusy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.mainButtonText}>
              {isMonitoring ? '停止监测' : '开始睡眠监测'}
            </Text>
          )}
        </TouchableOpacity>

        {isMonitoring && (
          <Text style={styles.tipText}>
            监测中…请保持应用在屏幕上，建议连接充电器。
          </Text>
        )}
      </View>

      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('history')}>
          <Text style={styles.navButtonText}>历史记录</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('settings')}>
          <Text style={styles.navButtonText}>灵敏度设置</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderHistory = () => (
    <View style={styles.flex}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>← 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>历史记录</Text>
        <View style={{ width: 40 }} />
      </View>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>暂无睡眠记录</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.historyItem}
            onPress={() => {
              setSelectedSession(item);
              setPlaybackPosMs(0);
              setPlaybackDurMs(0);
              setScreen('detail');
            }}
          >
            <View style={styles.historyRow}>
              <View>
                <Text style={styles.historyTime}>{formatTime(item.startTime)}</Text>
                <Text style={styles.historyMeta}>
                  睡眠 {formatDuration(item.durationSeconds)} · 打鼾 {item.snoreCount} 次 · 磨牙 {item.grindCount} 次
                </Text>
              </View>
              <View style={[styles.qualityBadge, { backgroundColor: getQualityColor(item.qualityScore) }]}>
                <Text style={styles.qualityText}>{item.qualityScore}分</Text>
              </View>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );

  const renderDetail = () => {
    if (!selectedSession) return null;
    return (
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setScreen('history')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.backText}>← 返回</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>记录详情</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.card}>
          <Text style={styles.detailTime}>{formatTime(selectedSession.startTime)}</Text>
          <View style={styles.detailStats}>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.durationSeconds)}</Text>
              <Text style={styles.detailStatLabel}>睡眠时长</Text>
            </View>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{selectedSession.snoreCount}</Text>
              <Text style={styles.detailStatLabel}>打鼾次数</Text>
            </View>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{selectedSession.grindCount}</Text>
              <Text style={styles.detailStatLabel}>磨牙次数</Text>
            </View>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getQualityColor(selectedSession.qualityScore) }]}>
            <Text style={styles.qualityTextLarge}>睡眠质量 {selectedSession.qualityScore} 分</Text>
          </View>

          {selectedSession.recordingUri ? (
            <View style={styles.recordingBox}>
              <Text style={styles.sectionTitle}>录音回放</Text>
              <TouchableOpacity
                style={[styles.mainButton, isPlaying ? styles.stopButton : styles.startButton]}
                onPress={() =>
                  isPlaying ? stopPlayback() : playRecording(selectedSession.recordingUri!)
                }
              >
                <Text style={styles.mainButtonText}>{isPlaying ? '停止播放' : '播放录音'}</Text>
              </TouchableOpacity>
              {/* 播放进度条 */}
              {playbackDurMs > 0 && (
                <View style={{ marginTop: 12 }}>
                  <View style={styles.volumeBarBg}>
                    <View
                      style={[
                        styles.volumeBarFill,
                        {
                          width: `${Math.min(100, (playbackPosMs / playbackDurMs) * 100)}%`,
                          backgroundColor: '#4ECDC4',
                        },
                      ]}
                    />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={styles.volumeDb}>{formatDuration(Math.floor(playbackPosMs / 1000))}</Text>
                    <Text style={styles.volumeDb}>{formatDuration(Math.floor(playbackDurMs / 1000))}</Text>
                  </View>
                </View>
              )}
            </View>
          ) : (
            <Text style={styles.noRecordingText}>未保存录音</Text>
          )}

          <Text style={styles.sectionTitle}>异常声音事件（点击跳转播放）</Text>
          {selectedSession.events.length === 0 ? (
            <Text style={styles.noRecordingText}>未检测到打鼾或磨牙事件</Text>
          ) : (
            selectedSession.events.map((evt, idx) => {
              const absStart = selectedSession.startTime + evt.start;
              const isCurrent =
                isPlaying && playbackPosMs >= evt.start - 500 && playbackPosMs <= evt.end + 500;
              return (
                <TouchableOpacity
                  key={idx}
                  style={[styles.eventRow, isCurrent ? { backgroundColor: 'rgba(78,205,196,0.15)' } : {}]}
                  onPress={() => selectedSession.recordingUri && seekToEvent(evt)}
                  disabled={!selectedSession.recordingUri}
                >
                  <Text style={[styles.eventIndex, evt.type === 'grind' ? { color: '#F1C40F' } : {}]}>
                    #{idx + 1} {evt.type === 'snore' ? '打鼾' : '磨牙'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventClock}>{formatClock(absStart)}</Text>
                    <Text style={styles.eventDuration}>{(evt.duration / 1000).toFixed(1)}秒</Text>
                  </View>
                  {selectedSession.recordingUri && (
                    <Text style={[styles.eventIndex, { color: '#4ECDC4', fontSize: 12 }]}>▶ 跳转</Text>
                  )}
                </TouchableOpacity>
              );
            })
          )}

          <View style={{ height: 16 }} />
          <Button
            title="删除此记录"
            color="#FF6B6B"
            onPress={() =>
              Alert.alert('确认删除', '删除后无法恢复，录音也将被删除。', [
                { text: '取消', style: 'cancel' },
                {
                  text: '删除',
                  style: 'destructive',
                  onPress: () => {
                    deleteSession(selectedSession.id);
                    setScreen('history');
                  },
                },
              ])
            }
          />
        </View>
      </ScrollView>
    );
  };

  const renderSettings = () => (
    <ScrollView style={styles.flex} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>← 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>灵敏度设置</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>鼾声检测阈值</Text>
        <Text style={styles.settingsDesc}>
          原生模块会先对 TFLite 模型输出做一次内部判断：只有“snoring”类别的置信度最高且超过 50% 时，才认为当前这一秒可能是鼾声。
          在此基础上，App 会再用下方阈值做二次过滤：只有当“snoring”置信度不低于该阈值，且连续满足条件达到最小持续时间，才会被记录为一次打鼾事件。
          阈值越低越灵敏，可能把环境音误判为鼾声；阈值越高越保守，可能漏掉轻微鼾声。推荐 45%–60%。
        </Text>
        <Text style={styles.thresholdValue}>{(snoreThreshold * 100).toFixed(0)}%</Text>
        <View style={styles.sliderRow}>
          <TouchableOpacity
            style={styles.adjustButton}
            onPress={() => {
              const val = Math.max(0.1, parseFloat((snoreThreshold - 0.05).toFixed(2)));
              setSnoreThreshold(val);
              saveSettings(val, grindThreshold);
            }}
          >
            <Text style={styles.adjustButtonText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.thresholdRangeText}>灵敏度</Text>
          <TouchableOpacity
            style={styles.adjustButton}
            onPress={() => {
              const val = Math.min(0.9, parseFloat((snoreThreshold + 0.05).toFixed(2)));
              setSnoreThreshold(val);
              saveSettings(val, grindThreshold);
            }}
          >
            <Text style={styles.adjustButtonText}>+</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 1, backgroundColor: '#E8EDF2', marginVertical: 20 }} />

        <Text style={styles.sectionTitle}>磨牙启发式灵敏度</Text>
        <Text style={styles.settingsDesc}>
          当前 TFLite 模型只包含 noise / snoring 两类，没有专门的磨牙（bruxism）类别。磨牙是通过“短时、响亮、且模型不认为是鼾声”的启发式规则推断的。
          该灵敏度控制“非鼾声但响亮”的帧被标记为磨牙候选的宽松程度：数值越高，越多的响亮片段会被尝试归类为磨牙；数值越低，越保守，可能把磨牙并入环境音。
          事件最终还会根据持续时间和鼾声帧比例来判定，因此该选项主要影响候选范围。
        </Text>
        <Text style={styles.thresholdValue}>{(grindThreshold * 100).toFixed(0)}%</Text>
        <View style={styles.sliderRow}>
          <TouchableOpacity
            style={styles.adjustButton}
            onPress={() => {
              const val = Math.max(0.1, parseFloat((grindThreshold - 0.05).toFixed(2)));
              setGrindThreshold(val);
              saveSettings(snoreThreshold, val);
            }}
          >
            <Text style={styles.adjustButtonText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.thresholdRangeText}>灵敏度</Text>
          <TouchableOpacity
            style={styles.adjustButton}
            onPress={() => {
              const val = Math.min(0.9, parseFloat((grindThreshold + 0.05).toFixed(2)));
              setGrindThreshold(val);
              saveSettings(snoreThreshold, val);
            }}
          >
            <Text style={styles.adjustButtonText}>+</Text>
          </TouchableOpacity>
        </View>
        <Button
          title="恢复默认"
          onPress={() => {
            setSnoreThreshold(DEFAULT_SNORE_CONFIDENCE);
            setGrindThreshold(DEFAULT_GRIND_CONFIDENCE);
            saveSettings(DEFAULT_SNORE_CONFIDENCE, DEFAULT_GRIND_CONFIDENCE);
          }}
        />
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      {screen === 'home' && renderHome()}
      {screen === 'history' && renderHistory()}
      {screen === 'detail' && renderDetail()}
      {screen === 'settings' && renderSettings()}
    </SafeAreaView>
  );
}

function getQualityColor(score: number): string {
  if (score >= 85) return '#2ECC71';
  if (score >= 60) return '#F1C40F';
  return '#E74C3C';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 16,
    color: '#7A8B9C',
  },
  flex: {
    flex: 1,
  },
  homeContent: {
    padding: 16,
    paddingTop: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1A2B3C',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#7A8B9C',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 20,
  },
  warningBox: {
    backgroundColor: '#FFF3E0',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  warningText: {
    color: '#E65100',
    marginBottom: 8,
  },
  timerBox: {
    alignItems: 'center',
    marginVertical: 16,
  },
  timerLabel: {
    fontSize: 14,
    color: '#7A8B9C',
  },
  timerValue: {
    fontSize: 48,
    fontWeight: '200',
    color: '#1A2B3C',
    fontVariant: ['tabular-nums'],
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 24,
  },
  statBox: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A2B3C',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 12,
    color: '#7A8B9C',
    marginTop: 4,
  },
  volumeBox: {
    marginBottom: 24,
  },
  volumeLabel: {
    fontSize: 14,
    color: '#7A8B9C',
    marginBottom: 8,
  },
  volumeBarBg: {
    height: 14,
    backgroundColor: '#E8EDF2',
    borderRadius: 7,
    overflow: 'hidden',
  },
  volumeBarFill: {
    height: '100%',
    borderRadius: 7,
  },
  volumeDb: {
    fontSize: 12,
    color: '#7A8B9C',
    marginTop: 6,
    textAlign: 'right',
  },
  volumeThreshold: {
    fontSize: 12,
    color: '#FF6B6B',
    fontWeight: '600',
  },
  mainButton: {
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButton: {
    backgroundColor: '#4ECDC4',
  },
  stopButton: {
    backgroundColor: '#FF6B6B',
  },
  mainButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  tipText: {
    fontSize: 12,
    color: '#7A8B9C',
    textAlign: 'center',
    marginTop: 12,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  navButton: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    marginHorizontal: 6,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  navButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1A2B3C',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    backgroundColor: '#fff',
  },
  backText: {
    fontSize: 16,
    color: '#4ECDC4',
    paddingVertical: 8,
    paddingHorizontal: 8,
    minWidth: 50,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A2B3C',
  },
  emptyBox: {
    alignItems: 'center',
    marginTop: 60,
  },
  emptyText: {
    color: '#7A8B9C',
    fontSize: 16,
  },
  historyItem: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyTime: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A2B3C',
  },
  historyMeta: {
    fontSize: 13,
    color: '#7A8B9C',
    marginTop: 4,
  },
  qualityBadge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  qualityText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  detailTime: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A2B3C',
    textAlign: 'center',
    marginBottom: 20,
  },
  detailStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
  },
  detailStat: {
    alignItems: 'center',
  },
  detailStatValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A2B3C',
    fontVariant: ['tabular-nums'],
  },
  detailStatLabel: {
    fontSize: 12,
    color: '#7A8B9C',
    marginTop: 4,
  },
  qualityBadgeLarge: {
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 24,
  },
  qualityTextLarge: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  recordingBox: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1A2B3C',
    marginBottom: 12,
  },
  noRecordingText: {
    color: '#7A8B9C',
    marginBottom: 16,
  },
  eventRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E8EDF2',
  },
  eventIndex: {
    width: 70,
    color: '#4ECDC4',
    fontWeight: '700',
  },
  eventTime: {
    flex: 1,
    color: '#1A2B3C',
    fontVariant: ['tabular-nums'],
  },
  eventClock: {
    color: '#1A2B3C',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  eventDuration: {
    color: '#7A8B9C',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  settingsDesc: {
    fontSize: 14,
    color: '#7A8B9C',
    lineHeight: 20,
    marginBottom: 16,
  },
  thresholdValue: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1A2B3C',
    textAlign: 'center',
    marginBottom: 12,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  adjustButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#4ECDC4',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
  },
  adjustButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 28,
  },
  thresholdRangeText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A2B3C',
    minWidth: 80,
    textAlign: 'center',
  },
});
