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
  Linking,
  StatusBar as RNStatusBar,
  Modal,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

// 原生音频模块（Android 专用，用 MediaRecorder.getMaxAmplitude 获取实时音量）
const AudioMeter = NativeModules.AudioMeter;

// 类型定义
interface SoundEvent {
  start: number; // 相对会话开始的毫秒数
  end: number;
  duration: number; // 毫秒
  type: 'snore' | 'grind' | 'talk' | 'apnea'; // 打鼾 | 磨牙 | 梦话 | 呼吸暂停
  intensity?: 'mild' | 'moderate' | 'severe'; // 仅用于打鼾强度分级
}

interface SleepSession {
  id: string;
  startTime: number;
  endTime?: number;
  durationSeconds: number;
  events: SoundEvent[];
  snoreCount: number;
  grindCount: number;
  talkCount: number;
  apneaCount: number;
  totalSnoreSeconds: number;
  totalGrindSeconds: number;
  totalTalkSeconds: number;
  totalApneaSeconds: number;
  recordingUri?: string;
  qualityScore: number; // 0-100
  apneaRisk?: 'low' | 'moderate' | 'high'; // 呼吸暂停筛查风险
  intensityBreakdown?: { mild: number; moderate: number; severe: number }; // 鼾声强度分布
}

type Screen = 'home' | 'history' | 'detail' | 'settings';

// 常量
const CURRENT_VERSION = '1.1.0';
const GITHUB_OWNER = '846515182';
const GITHUB_REPO = 'SnoreSleepMonitor';
const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const STORAGE_KEY = '@snore_sessions_v2';
const SETTINGS_KEY = '@snore_settings_v2';
const CHUNK_MS = 300; // 监测循环周期（更频繁采样）
const DEFAULT_SNORE_CONFIDENCE = 0.45; // 默认鼾声置信度阈值（YAMNet 更准，可适当放宽）
const DEFAULT_GRIND_CONFIDENCE = 0.35; // 默认磨牙置信度阈值
const DEFAULT_TALK_CONFIDENCE = 0.5; // 默认梦话置信度阈值
const DEFAULT_APNEA_CONFIDENCE = 0.45; // 默认呼吸暂停（Gasp 等）置信度阈值
const FALLBACK_THRESHOLD_DB = -60; // expo-av 回退方案音量阈值
const MIN_SNORE_MS = 500; // 最小打鼾持续时间 0.5 秒
const MIN_GRIND_MS = 300; // 最小磨牙持续时间 0.3 秒
const MAX_GRIND_MS = 1500; // 磨牙事件一般不超过 1.5 秒
const MIN_TALK_MS = 500; // 最小梦话持续时间 0.5 秒
const MIN_APNEA_MS = 200; // 最小呼吸暂停事件 0.2 秒
const MAX_APNEA_MS = 2000; // 呼吸暂停事件一般不超过 2 秒
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

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function compareVersion(local: string, remote: string): number {
  const a = parseVersion(local);
  const b = parseVersion(remote);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

interface LatestRelease {
  version: string;
  downloadUrl: string;
  body: string;
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(GITHUB_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const apkAsset = (data.assets || []).find((a: any) => a.name?.endsWith('.apk'));
    if (!apkAsset?.browser_download_url) return null;
    return {
      version: data.tag_name || '',
      downloadUrl: apkAsset.browser_download_url,
      body: data.body || '',
    };
  } catch (e) {
    console.warn('检查更新失败', e);
    return null;
  }
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
  const [grindConfidence, setGrindConfidence] = useState(0);
  const [talkConfidence, setTalkConfidence] = useState(0);
  const [apneaConfidence, setApneaConfidence] = useState(0);
  const [topClass, setTopClass] = useState('noise');
  const [topConfidence, setTopConfidence] = useState(0);
  const [confidences, setConfidences] = useState<Record<string, number>>({});
  const [isSnoringNow, setIsSnoringNow] = useState(false);
  const [snoreIntensity, setSnoreIntensity] = useState<'mild' | 'moderate' | 'severe' | null>(null);
  const [sleepStartTime, setSleepStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [snoreCount, setSnoreCount] = useState(0);
  const [grindCount, setGrindCount] = useState(0);
  const [talkCount, setTalkCount] = useState(0);
  const [apneaCount, setApneaCount] = useState(0);
  const [totalNoiseSeconds, setTotalNoiseSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosMs, setPlaybackPosMs] = useState(0); // 当前播放位置（毫秒）
  const [playbackDurMs, setPlaybackDurMs] = useState(0); // 录音总时长（毫秒）
  const [isReady, setIsReady] = useState(false);
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);
  const [updateCheckState, setUpdateCheckState] = useState<'idle' | 'checking' | 'available' | 'latest' | 'error'>('idle');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState('准备下载…');

  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingUriRef = useRef<string>('');
  const useNativeMeterRef = useRef<boolean>(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const monitorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventsRef = useRef<SoundEvent[]>([]);
  const currentEventRef = useRef<SoundEvent | null>(null);
  const currentSnoreFramesRef = useRef<number>(0);
  const currentGrindFramesRef = useRef<number>(0);
  const currentTalkFramesRef = useRef<number>(0);
  const currentApneaFramesRef = useRef<number>(0);
  const currentTotalFramesRef = useRef<number>(0);
  const currentMaxSnoreConfRef = useRef<number>(0);
  const lastEventEndRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const lastMeteringRef = useRef<number>(-100); // expo-av 回调方式的最新 metering 值
  const downloadResumableRef = useRef<FileSystem.DownloadResumable | null>(null);

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
        checkUpdate(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const checkUpdate = async (interactive = false) => {
    if (interactive) setUpdateCheckState('checking');
    const release = await fetchLatestRelease();
    if (!release) {
      if (interactive) setUpdateCheckState('error');
      return;
    }
    setLatestRelease(release);
    const cmp = compareVersion(CURRENT_VERSION, release.version);
    if (cmp < 0) {
      setUpdateCheckState('available');
      Alert.alert(
        '发现新版本',
        `当前版本：${CURRENT_VERSION}\n最新版本：${release.version}\n\n是否立即下载更新？`,
        [
          { text: '稍后再说', style: 'cancel' },
          { text: '立即更新', onPress: () => downloadAndInstallApk(release.downloadUrl) },
        ]
      );
    } else {
      setUpdateCheckState('latest');
      if (interactive) {
        Alert.alert('已是最新版本', `当前版本 ${CURRENT_VERSION} 已是最新。`);
      }
    }
  };

  const openUpdateUrl = async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert('无法打开下载链接', url);
      }
    } catch (e) {
      Alert.alert('打开链接失败', String(e));
    }
  };

  const cancelDownload = async () => {
    try {
      if (downloadResumableRef.current) {
        await downloadResumableRef.current.cancelAsync();
        downloadResumableRef.current = null;
      }
    } catch (e) {
      console.warn('取消下载失败', e);
    }
    setIsDownloading(false);
    setDownloadProgress(0);
    setDownloadStatus('已取消下载');
  };

  const downloadAndInstallApk = async (url: string) => {
    if (Platform.OS !== 'android') {
      openUpdateUrl(url);
      return;
    }

    if (isDownloading) {
      Alert.alert('下载中', '已有更新任务在下载，请等待完成。');
      return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadStatus('准备下载…');

    try {
      // 请求存储权限（Android 6.0-9.0 下载到缓存外需要，这里先顺手申请）
      if (Platform.Version && Number(Platform.Version) < 29) {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
        } catch {
          // 忽略权限申请失败，缓存目录不需要此权限
        }
      }

      const fileName = `update_${Date.now()}.apk`;
      const fileUri = FileSystem.cacheDirectory + fileName;

      setDownloadStatus('正在下载…');
      downloadResumableRef.current = FileSystem.createDownloadResumable(
        url,
        fileUri,
        {},
        (progress) => {
          const total = progress.totalBytesExpectedToWrite || 1;
          const written = progress.totalBytesWritten || 0;
          const pct = Math.min(1, Math.max(0, written / total));
          setDownloadProgress(pct);
          setDownloadStatus(`正在下载… ${Math.round(pct * 100)}%`);
        }
      );

      const result = await downloadResumableRef.current.downloadAsync();
      downloadResumableRef.current = null;
      if (!result) {
        throw new Error('下载失败，请检查网络');
      }

      setDownloadStatus('下载完成，准备安装…');
      setDownloadProgress(1);

      // 获取 content:// URI 并启动安装界面
      const contentUri = await FileSystem.getContentUriAsync(result.uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      });

      setIsDownloading(false);
    } catch (e) {
      downloadResumableRef.current = null;
      setIsDownloading(false);
      setDownloadProgress(0);
      console.warn('下载或安装失败', e);
      Alert.alert(
        '更新失败',
        `${String(e)}\n\n可能原因：\n1. 未开启"允许安装未知应用"权限\n2. 下载链接无法访问\n\n是否改用浏览器下载？`,
        [
          { text: '取消', style: 'cancel' },
          { text: '浏览器下载', onPress: () => openUpdateUrl(url) },
        ]
      );
    }
  };

  const loadSessions = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: SleepSession[] = JSON.parse(raw);
        // 兼容旧数据：新版本字段不存在时补默认值
        const normalized = parsed.map((s) => ({
          ...s,
          talkCount: s.talkCount ?? 0,
          apneaCount: s.apneaCount ?? 0,
          totalTalkSeconds: s.totalTalkSeconds ?? 0,
          totalApneaSeconds: s.totalApneaSeconds ?? 0,
          apneaRisk: s.apneaRisk ?? 'low',
          intensityBreakdown: s.intensityBreakdown ?? { mild: 0, moderate: 0, severe: 0 },
          events: (s.events || []).map((e) => ({
            ...e,
            type: e.type || 'snore',
            intensity: e.intensity,
          })),
        }));
        normalized.sort((a, b) => b.startTime - a.startTime);
        setSessions(normalized);
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
      setTalkCount(0);
      setApneaCount(0);
      setTotalNoiseSeconds(0);
      setVolumeDb(-100);
      setSnoreConfidence(0);
      setGrindConfidence(0);
      setTalkConfidence(0);
      setApneaConfidence(0);
      setTopClass('noise');
      setTopConfidence(0);
      setConfidences({});
      setSnoreIntensity(null);
      eventsRef.current = [];
      currentEventRef.current = null;
      currentSnoreFramesRef.current = 0;
      currentGrindFramesRef.current = 0;
      currentTalkFramesRef.current = 0;
      currentApneaFramesRef.current = 0;
      currentTotalFramesRef.current = 0;
      currentMaxSnoreConfRef.current = 0;
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

  const classifyIntensity = (conf: number): 'mild' | 'moderate' | 'severe' => {
    if (conf >= 0.75) return 'severe';
    if (conf >= 0.55) return 'moderate';
    return 'mild';
  };

  const monitorLoop = async () => {
    // 原生模块路径：使用 YAMNet 多分类模型
    if (useNativeMeterRef.current && AudioMeter) {
      try {
        const result = await AudioMeter.getLatestResult();
        const metering = typeof result.amplitudeDb === 'number' ? result.amplitudeDb : -100;
        const confs: Record<string, number> = result.confidences || {};
        const sConf = confs.snoring ?? 0;
        const gConf = confs.grinding ?? 0;
        const tConf = confs.talking ?? 0;
        const aConf = confs.apnea ?? 0;
        const nConf = confs.noise ?? 0;
        const tClass = typeof result.topClass === 'string' ? result.topClass : 'noise';
        const tConfAll = typeof result.topConfidence === 'number' ? result.topConfidence : 0;
        setVolumeDb(metering);
        setSnoreConfidence(sConf);
        setGrindConfidence(gConf);
        setTalkConfidence(tConf);
        setApneaConfidence(aConf);
        setTopClass(tClass);
        setTopConfidence(tConfAll);
        setConfidences(confs);
        if (metering > maxVolumeDbRef.current) {
          maxVolumeDbRef.current = metering;
          setMaxVolumeDb(metering);
        }

        const now = Date.now();
        const sessionElapsed = now - startTimeRef.current;
        setElapsedSeconds(Math.floor(sessionElapsed / 1000));

        // 按当前 top 类别做阈值判断，避免同一帧被重复归类
        const isSnoreFrame = tClass === 'snoring' && sConf >= snoreThreshold;
        const isGrindFrame = tClass === 'grinding' && gConf >= grindThreshold;
        const isTalkFrame = tClass === 'talking' && tConf >= DEFAULT_TALK_CONFIDENCE;
        const isApneaFrame = tClass === 'apnea' && aConf >= DEFAULT_APNEA_CONFIDENCE;
        const isLoud = isSnoreFrame || isGrindFrame || isTalkFrame || isApneaFrame;

        if (isSnoreFrame) {
          setSnoreIntensity(classifyIntensity(sConf));
        } else if (!isLoud) {
          setSnoreIntensity(null);
        }
        setIsSnoringNow(isLoud);
        detectEvent(isSnoreFrame, isGrindFrame, isTalkFrame, isApneaFrame, sessionElapsed, sConf);
      } catch (e) {
        console.warn('原生监测循环异常', e);
      }
      return;
    }

    // expo-av 回退路径：从 onRecordingStatusUpdate 回调读取最新 metering
    const metering = lastMeteringRef.current;
    setVolumeDb(metering);
    setSnoreConfidence(0);
    setGrindConfidence(0);
    setTalkConfidence(0);
    setApneaConfidence(0);
    setTopClass('noise');
    setTopConfidence(0);
    setConfidences({});
    setSnoreIntensity(null);
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
    detectEvent(isLoud, false, false, false, sessionElapsed, 0);
  };

  // 事件检测：按帧标记为鼾声/磨牙/梦话/呼吸暂停，事件结束时根据帧比例与持续时间分类。
  const detectEvent = (
    isSnoreFrame: boolean,
    isGrindFrame: boolean,
    isTalkFrame: boolean,
    isApneaFrame: boolean,
    sessionElapsed: number,
    snoreConf: number
  ) => {
    const isLoud = isSnoreFrame || isGrindFrame || isTalkFrame || isApneaFrame;

    if (isLoud) {
      lastLoudTimeRef.current = sessionElapsed;
      if (!currentEventRef.current) {
        currentEventRef.current = {
          start: sessionElapsed,
          end: sessionElapsed,
          duration: 0,
          type: 'snore',
        };
        currentSnoreFramesRef.current = isSnoreFrame ? 1 : 0;
        currentGrindFramesRef.current = isGrindFrame ? 1 : 0;
        currentTalkFramesRef.current = isTalkFrame ? 1 : 0;
        currentApneaFramesRef.current = isApneaFrame ? 1 : 0;
        currentTotalFramesRef.current = 1;
        currentMaxSnoreConfRef.current = isSnoreFrame ? snoreConf : 0;
      } else {
        currentEventRef.current.end = sessionElapsed;
        currentEventRef.current.duration = sessionElapsed - currentEventRef.current.start;
        currentTotalFramesRef.current += 1;
        if (isSnoreFrame) {
          currentSnoreFramesRef.current += 1;
          if (snoreConf > currentMaxSnoreConfRef.current) {
            currentMaxSnoreConfRef.current = snoreConf;
          }
        }
        if (isGrindFrame) currentGrindFramesRef.current += 1;
        if (isTalkFrame) currentTalkFramesRef.current += 1;
        if (isApneaFrame) currentApneaFramesRef.current += 1;
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
    const total = currentTotalFramesRef.current;
    const snoreRatio = total > 0 ? currentSnoreFramesRef.current / total : 0;
    const grindRatio = total > 0 ? currentGrindFramesRef.current / total : 0;
    const talkRatio = total > 0 ? currentTalkFramesRef.current / total : 0;
    const apneaRatio = total > 0 ? currentApneaFramesRef.current / total : 0;

    let type: SoundEvent['type'] = 'snore';
    let valid = false;

    if (snoreRatio >= 0.5 && duration >= MIN_SNORE_MS) {
      type = 'snore';
      valid = true;
      evt.intensity = classifyIntensity(currentMaxSnoreConfRef.current);
    } else if (apneaRatio >= 0.5 && duration >= MIN_APNEA_MS && duration <= MAX_APNEA_MS) {
      type = 'apnea';
      valid = true;
    } else if (talkRatio >= 0.5 && duration >= MIN_TALK_MS) {
      type = 'talk';
      valid = true;
    } else if (grindRatio >= 0.5 && duration >= MIN_GRIND_MS && duration <= MAX_GRIND_MS) {
      type = 'grind';
      valid = true;
    }

    if (valid) {
      evt.type = type;
      eventsRef.current.push({ ...evt });
      if (type === 'snore') setSnoreCount((c) => c + 1);
      else if (type === 'grind') setGrindCount((c) => c + 1);
      else if (type === 'talk') setTalkCount((c) => c + 1);
      else if (type === 'apnea') setApneaCount((c) => c + 1);
      lastEventEndRef.current = evt.end;
    }

    currentEventRef.current = null;
    currentSnoreFramesRef.current = 0;
    currentGrindFramesRef.current = 0;
    currentTalkFramesRef.current = 0;
    currentApneaFramesRef.current = 0;
    currentTotalFramesRef.current = 0;
    currentMaxSnoreConfRef.current = 0;
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
      const talkEvents = eventsRef.current.filter((e) => e.type === 'talk');
      const apneaEvents = eventsRef.current.filter((e) => e.type === 'apnea');
      const totalSnoreMs = snoreEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalGrindMs = grindEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalTalkMs = talkEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalApneaMs = apneaEvents.reduce((sum, e) => sum + e.duration, 0);
      const totalNoiseSec = Math.floor((totalSnoreMs + totalGrindMs + totalTalkMs + totalApneaMs) / 1000);

      // 鼾声强度分布
      const intensityBreakdown = {
        mild: snoreEvents.filter((e) => e.intensity === 'mild').length,
        moderate: snoreEvents.filter((e) => e.intensity === 'moderate').length,
        severe: snoreEvents.filter((e) => e.intensity === 'severe').length,
      };

      // 呼吸暂停风险指数（AHI 简化版：事件数 / 睡眠小时数）
      const hours = durationSeconds / 3600;
      const ahi = hours > 0 ? apneaEvents.length / hours : 0;
      let apneaRisk: SleepSession['apneaRisk'] = 'low';
      if (ahi >= 15) apneaRisk = 'high';
      else if (ahi >= 5) apneaRisk = 'moderate';

      const session: SleepSession = {
        id: `${startTimeRef.current}`,
        startTime: startTimeRef.current,
        endTime,
        durationSeconds,
        events: eventsRef.current,
        snoreCount: snoreEvents.length,
        grindCount: grindEvents.length,
        talkCount: talkEvents.length,
        apneaCount: apneaEvents.length,
        totalSnoreSeconds: Math.floor(totalSnoreMs / 1000),
        totalGrindSeconds: Math.floor(totalGrindMs / 1000),
        totalTalkSeconds: Math.floor(totalTalkMs / 1000),
        totalApneaSeconds: Math.floor(totalApneaMs / 1000),
        recordingUri: uri,
        qualityScore: calculateQualityScore(durationSeconds, totalNoiseSec),
        apneaRisk,
        intensityBreakdown,
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
    setGrindConfidence(0);
    setTalkConfidence(0);
    setApneaConfidence(0);
    setTopClass('noise');
    setTopConfidence(0);
    setConfidences({});
    setSnoreIntensity(null);
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
            <Text style={styles.statLabel}>打鼾</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{grindCount}</Text>
            <Text style={styles.statLabel}>磨牙</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{talkCount}</Text>
            <Text style={styles.statLabel}>梦话</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{apneaCount}</Text>
            <Text style={styles.statLabel}>呼吸暂停</Text>
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
            模型: {topClass} {(topConfidence * 100).toFixed(1)}% · 鼾{(snoreConfidence * 100).toFixed(0)}% 磨{(grindConfidence * 100).toFixed(0)}% 话{(talkConfidence * 100).toFixed(0)}% 停{(apneaConfidence * 100).toFixed(0)}%
          </Text>
          {snoreIntensity && (
            <Text style={[styles.volumeDb, { color: getIntensityColor(snoreIntensity), marginTop: 4 }]}>
              鼾声强度: {getIntensityLabel(snoreIntensity)}
            </Text>
          )}
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
                  睡眠 {formatDuration(item.durationSeconds)} · 鼾{item.snoreCount} · 磨{item.grindCount} · 话{item.talkCount} · 停{item.apneaCount}
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
              <Text style={styles.detailStatLabel}>打鼾</Text>
            </View>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{selectedSession.grindCount}</Text>
              <Text style={styles.detailStatLabel}>磨牙</Text>
            </View>
          </View>

          <View style={styles.detailStats}>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{selectedSession.talkCount}</Text>
              <Text style={styles.detailStatLabel}>梦话</Text>
            </View>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{selectedSession.apneaCount}</Text>
              <Text style={styles.detailStatLabel}>呼吸暂停</Text>
            </View>
            <View style={styles.detailStat}>
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalSnoreSeconds)}</Text>
              <Text style={styles.detailStatLabel}>鼾声时长</Text>
            </View>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getQualityColor(selectedSession.qualityScore) }]}>
            <Text style={styles.qualityTextLarge}>睡眠质量 {selectedSession.qualityScore} 分</Text>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getApneaRiskColor(selectedSession.apneaRisk || 'low'), marginTop: -12 }]}>
            <Text style={styles.qualityTextLarge}>呼吸暂停风险 {getApneaRiskLabel(selectedSession.apneaRisk || 'low')}</Text>
          </View>

          {selectedSession.intensityBreakdown && selectedSession.snoreCount > 0 && (
            <View style={{ marginBottom: 20 }}>
              <Text style={styles.sectionTitle}>鼾声强度分布</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                <View style={styles.detailStat}>
                  <Text style={[styles.detailStatValue, { color: '#2ECC71' }]}>{selectedSession.intensityBreakdown.mild}</Text>
                  <Text style={styles.detailStatLabel}>轻度</Text>
                </View>
                <View style={styles.detailStat}>
                  <Text style={[styles.detailStatValue, { color: '#F1C40F' }]}>{selectedSession.intensityBreakdown.moderate}</Text>
                  <Text style={styles.detailStatLabel}>中度</Text>
                </View>
                <View style={styles.detailStat}>
                  <Text style={[styles.detailStatValue, { color: '#E74C3C' }]}>{selectedSession.intensityBreakdown.severe}</Text>
                  <Text style={styles.detailStatLabel}>重度</Text>
                </View>
              </View>
            </View>
          )}

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
                  <Text style={[styles.eventIndex, { color: getEventColor(evt.type) }]}>
                    #{idx + 1} {getEventLabel(evt.type, evt.intensity)}
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
          本版本使用 Google YAMNet 521 类音频模型，原生模块已聚合出“打鼾 / 磨牙 / 梦话 / 呼吸暂停 / 噪音”五类置信度。
          App 会再用下方阈值做二次过滤：只有当“打鼾”置信度不低于该阈值，且连续满足条件达到最小持续时间，才会被记录为一次打鼾事件。
          阈值越低越灵敏，可能把环境音误判为鼾声；阈值越高越保守，可能漏掉轻微鼾声。推荐 40%–60%。
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

        <Text style={styles.sectionTitle}>磨牙检测阈值</Text>
        <Text style={styles.settingsDesc}>
          YAMNet 模型通过“咀嚼 / 咬合”类声音来识别磨牙（bruxism）候选。当“磨牙”聚合置信度不低于该阈值，且事件持续时间在 0.3–1.5 秒之间，才会被记录为一次磨牙。
          阈值越低越灵敏，可能把翻身、衣物摩擦等误判为磨牙；阈值越高越保守，可能漏掉轻微磨牙。推荐 30%–45%。
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

        <View style={{ height: 1, backgroundColor: '#E8EDF2', marginVertical: 20 }} />

        <Text style={styles.sectionTitle}>应用更新</Text>
        <Text style={styles.settingsDesc}>
          当前版本：{CURRENT_VERSION}
          {latestRelease && updateCheckState === 'available' && ` → 最新版本：${latestRelease.version}`}
        </Text>
        {updateCheckState === 'available' && latestRelease && (
          <TouchableOpacity
            style={[styles.mainButton, styles.startButton, { marginBottom: 12 }]}
            onPress={() => downloadAndInstallApk(latestRelease.downloadUrl)}
          >
            <Text style={styles.mainButtonText}>下载最新版本 APK</Text>
          </TouchableOpacity>
        )}
        <Button
          title={updateCheckState === 'checking' ? '检查中…' : '检查更新'}
          onPress={() => checkUpdate(true)}
          disabled={updateCheckState === 'checking'}
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

      <Modal
        transparent
        animationType="fade"
        visible={isDownloading}
        onRequestClose={() => {}}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.updateModal}>
            <Text style={styles.updateModalTitle}>正在下载更新</Text>
            <Text style={styles.updateModalStatus}>{downloadStatus}</Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(downloadProgress * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.updateModalPercent}>
              {Math.round(downloadProgress * 100)}%
            </Text>
            <TouchableOpacity
              style={[styles.mainButton, styles.stopButton, { marginTop: 16, paddingVertical: 12 }]}
              onPress={cancelDownload}
            >
              <Text style={styles.mainButtonText}>取消下载</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function getQualityColor(score: number): string {
  if (score >= 85) return '#2ECC71';
  if (score >= 60) return '#F1C40F';
  return '#E74C3C';
}

function getIntensityColor(intensity: 'mild' | 'moderate' | 'severe'): string {
  switch (intensity) {
    case 'severe': return '#E74C3C';
    case 'moderate': return '#F1C40F';
    default: return '#2ECC71';
  }
}

function getIntensityLabel(intensity: 'mild' | 'moderate' | 'severe'): string {
  switch (intensity) {
    case 'severe': return '重度';
    case 'moderate': return '中度';
    default: return '轻度';
  }
}

function getApneaRiskColor(risk: 'low' | 'moderate' | 'high'): string {
  switch (risk) {
    case 'high': return '#E74C3C';
    case 'moderate': return '#F1C40F';
    default: return '#2ECC71';
  }
}

function getApneaRiskLabel(risk: 'low' | 'moderate' | 'high'): string {
  switch (risk) {
    case 'high': return '高风险';
    case 'moderate': return '中风险';
    default: return '低风险';
  }
}

function getEventColor(type: SoundEvent['type']): string {
  switch (type) {
    case 'snore': return '#4ECDC4';
    case 'grind': return '#F1C40F';
    case 'talk': return '#9B59B6';
    case 'apnea': return '#E74C3C';
    default: return '#7A8B9C';
  }
}

function getEventLabel(type: SoundEvent['type'], intensity?: SoundEvent['intensity']): string {
  const base =
    type === 'snore' ? '打鼾' :
    type === 'grind' ? '磨牙' :
    type === 'talk' ? '梦话' :
    type === 'apnea' ? '呼吸暂停' : '未知';
  if (type === 'snore' && intensity) {
    return `${base}(${getIntensityLabel(intensity)})`;
  }
  return base;
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
    paddingTop: (RNStatusBar.currentHeight || 0) + 16,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  updateModal: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
  },
  updateModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A2B3C',
    marginBottom: 8,
  },
  updateModalStatus: {
    fontSize: 14,
    color: '#7A8B9C',
    marginBottom: 16,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    backgroundColor: '#E8EDF2',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#4ECDC4',
    borderRadius: 5,
  },
  updateModalPercent: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4ECDC4',
  },
});
