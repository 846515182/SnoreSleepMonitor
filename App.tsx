import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
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
  Dimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';

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
const CURRENT_VERSION = '1.1.7';
const GITHUB_OWNER = '846515182';
const GITHUB_REPO = 'SnoreSleepMonitor';
const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const STORAGE_KEY = '@snore_sessions_v2';
const SETTINGS_KEY = '@snore_settings_v2';
const CHUNK_MS = 300; // 监测循环周期（更频繁采样）
const DEFAULT_SNORE_CONFIDENCE = 0.45; // 默认鼾声置信度阈值（YAMNet 更准，可适当放宽）
const DEFAULT_GRIND_CONFIDENCE = 0.25; // 默认磨牙置信度阈值（YAMNet 聚合分数）
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
const MAX_RECORDING_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 保留 7 天录音
const MAX_CACHED_APKS = 3; // 最多保留几个更新包

// 主题色与设计 token
const THEME = {
  primary: '#4ECDC4',
  primaryDark: '#3DBDB5',
  danger: '#FF6B6B',
  dangerDark: '#E85C5C',
  warning: '#FFD93D',
  success: '#2ECC71',
  text: '#1A2B3C',
  textSecondary: '#7A8B9C',
  textTertiary: '#A0AEBB',
  background: '#F5F7FA',
  card: '#FFFFFF',
  border: '#E8EDF2',
  snore: '#4ECDC4',
  grind: '#FFD93D',
  talk: '#9B59B6',
  apnea: '#FF6B6B',
  noise: '#7A8B9C',
} as const;

const { width: SCREEN_W } = Dimensions.get('window');

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

function formatBytes(bytes?: number): string {
  if (bytes == null || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function cachePath(name: string): string {
  const dir = FileSystem.cacheDirectory || '';
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
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
  size?: number;
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(GITHUB_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${GITHUB_REPO}/${CURRENT_VERSION}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      if (res.status === 403) {
        console.warn('GitHub API 频率受限，请稍后再试');
      }
      return null;
    }
    const data = await res.json();
    const apkAsset = (data.assets || []).find((a: any) => a.name?.endsWith('.apk'));
    if (!apkAsset?.browser_download_url) return null;
    return {
      version: data.tag_name || '',
      downloadUrl: apkAsset.browser_download_url,
      body: data.body || '',
      size: typeof apkAsset.size === 'number' ? apkAsset.size : undefined,
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
  const [talkThreshold, setTalkThreshold] = useState(DEFAULT_TALK_CONFIDENCE);
  const [apneaThreshold, setApneaThreshold] = useState(DEFAULT_APNEA_CONFIDENCE);
  const [snoreConfidence, setSnoreConfidence] = useState(0);
  const [grindConfidence, setGrindConfidence] = useState(0);
  const [talkConfidence, setTalkConfidence] = useState(0);
  const [apneaConfidence, setApneaConfidence] = useState(0);
  const [topClass, setTopClass] = useState('noise');
  const [topConfidence, setTopConfidence] = useState(0);
  const [confidences, setConfidences] = useState<Record<string, number>>({});
  const [isSnoringNow, setIsSnoringNow] = useState(false);
  const [snoreIntensity, setSnoreIntensity] = useState<'mild' | 'moderate' | 'severe' | null>(null);
  const [isFallbackMode, setIsFallbackMode] = useState(false); // true = 使用 expo-av 降级，无 AI 模型
  const [sleepStartTime, setSleepStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [snoreCount, setSnoreCount] = useState(0);
  const [grindCount, setGrindCount] = useState(0);
  const [talkCount, setTalkCount] = useState(0);
  const [apneaCount, setApneaCount] = useState(0);
  const [totalNoiseSeconds, setTotalNoiseSeconds] = useState(0);
  const [snoreSeconds, setSnoreSeconds] = useState(0);
  const [grindSeconds, setGrindSeconds] = useState(0);
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [apneaSeconds, setApneaSeconds] = useState(0);
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
  const startTimeRef = useRef<number>(0);
  const lastMeteringRef = useRef<number>(-100); // expo-av 回调方式的最新 metering 值
  const lastLoudTimeRef = useRef<number>(0); // 最后一次响亮的时间
  const maxVolumeDbRef = useRef<number>(-100); // 本次监测最大音量
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
          if (typeof settings.talkThreshold === 'number' && mounted) {
            setTalkThreshold(Math.max(0.1, Math.min(0.9, settings.talkThreshold)));
          }
          if (typeof settings.apneaThreshold === 'number' && mounted) {
            setApneaThreshold(Math.max(0.1, Math.min(0.9, settings.apneaThreshold)));
          }
        }
      } catch (e) {
        console.warn('加载设置失败', e);
      }
      await loadSessions();
      await cleanOldRecordings();
      const permitted = await checkPermission();
      if (mounted) {
        setHasPermission(permitted);
        setIsReady(true);
        checkUpdate(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const promptUpdate = (release: LatestRelease) => {
    Alert.alert(
      '发现新版本',
      `当前版本：${CURRENT_VERSION}\n最新版本：${release.version}\n\n是否立即下载更新？`,
      [
        { text: '稍后再说', style: 'cancel' },
        { text: '立即更新', onPress: () => downloadAndInstallApk(release.downloadUrl) },
      ]
    );
  };

  const checkUpdate = async (interactive = false) => {
    if (interactive) setUpdateCheckState('checking');
    const release = await fetchLatestRelease();
    if (!release) {
      if (interactive) {
        setUpdateCheckState('error');
        Alert.alert('检查更新失败', '无法获取最新版本信息，请检查网络连接后重试。');
      }
      return;
    }
    setLatestRelease(release);
    const cmp = compareVersion(CURRENT_VERSION, release.version);
    if (cmp < 0) {
      setUpdateCheckState('available');
      // 仅在用户主动点击“检查更新”时弹窗；启动时自动检查只显示角标，避免打扰。
      if (interactive && release) {
        promptUpdate(release);
      }
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

  // 清理旧 APK 缓存，保留最近 MAX_CACHED_APKS 个，避免占用空间并确保覆盖安装干净。
  const cleanUpdateCache = async (keepFileName?: string) => {
    try {
      if (!FileSystem.cacheDirectory) return;
      const entries = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
      const oldApks = entries
        .filter((name) => name.startsWith('update_') && name.endsWith('.apk'))
        .sort()
        .reverse();
      const toDelete = oldApks.filter((name) => name !== keepFileName).slice(MAX_CACHED_APKS);
      await Promise.all(
        toDelete.map((name) => FileSystem.deleteAsync(cachePath(name), { idempotent: true }).catch(() => {}))
      );
    } catch (e) {
      console.warn('清理更新缓存失败', e);
    }
  };

  // 清理应用自身缓存目录（不包括要安装的 APK），用于更新前释放空间、避免旧数据干扰。
  const cleanAppCache = async (excludeApkName?: string) => {
    try {
      if (!FileSystem.cacheDirectory) return;
      const entries = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
      await Promise.all(
        entries.map(async (name) => {
          if (name === excludeApkName) return;
          if (name.startsWith('update_') && name.endsWith('.apk')) return; // 由 cleanUpdateCache 管理
          const itemUri = cachePath(name);
          try {
            const info = await FileSystem.getInfoAsync(itemUri);
            if (info.exists && info.isDirectory) return; // 不删除目录，避免误删关键数据
            await FileSystem.deleteAsync(itemUri, { idempotent: true });
          } catch {
            // 忽略无法删除的项
          }
        })
      );
    } catch (e) {
      console.warn('清理应用缓存失败', e);
    }
  };

  // 清理超过保留期的录音文件，防止缓存无限增长。
  const cleanOldRecordings = async () => {
    try {
      const recordingsDir = cachePath('recordings');
      const info = await FileSystem.getInfoAsync(recordingsDir);
      if (!info.exists || !info.isDirectory) return;
      const entries = await FileSystem.readDirectoryAsync(recordingsDir);
      const now = Date.now();
      await Promise.all(
        entries.map(async (name) => {
          if (!name.endsWith('.wav')) return;
          try {
            const fileUri = recordingsDir.endsWith('/') ? `${recordingsDir}${name}` : `${recordingsDir}/${name}`;
            const fileInfo = await FileSystem.getInfoAsync(fileUri);
            if (fileInfo.exists && fileInfo.modificationTime && now - fileInfo.modificationTime > MAX_RECORDING_AGE_MS) {
              await FileSystem.deleteAsync(fileInfo.uri, { idempotent: true });
            }
          } catch {
            // ignore
          }
        })
      );
    } catch (e) {
      console.warn('清理旧录音失败', e);
    }
  };

  const downloadAndInstallApk = async (url: string, interactive = true) => {
    if (Platform.OS !== 'android') {
      openUpdateUrl(url);
      return;
    }

    if (isDownloading) {
      if (interactive) Alert.alert('下载中', '已有更新任务在下载，请等待完成。');
      return;
    }

    // 覆盖安装前提示用户：新版会替换旧版并清理应用缓存。
    if (interactive) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          '覆盖安装确认',
          '下载完成后将使用新版 APK 覆盖安装旧版，并清理应用缓存（不会影响历史记录）。是否继续？',
          [
            { text: '取消', style: 'cancel', onPress: () => resolve(false) },
            { text: '继续', onPress: () => resolve(true) },
          ]
        );
      });
      if (!confirmed) return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadStatus('准备下载…');

    try {
      const fileName = `update_${Date.now()}.apk`;
      const fileUri = cachePath(fileName);
      const expectedSize = latestRelease?.size;

      // 下载前清理旧的更新包和过期录音，减少存储占用。
      await cleanUpdateCache(fileName);
      await cleanOldRecordings();

      setDownloadStatus(expectedSize ? `正在下载… 0% / ${formatBytes(expectedSize)}` : '正在下载…');
      downloadResumableRef.current = FileSystem.createDownloadResumable(
        url,
        fileUri,
        {},
        (progress) => {
          const total = progress.totalBytesExpectedToWrite || expectedSize || 1;
          const written = progress.totalBytesWritten || 0;
          const pct = Math.min(1, Math.max(0, written / total));
          setDownloadProgress(pct);
          setDownloadStatus(
            `正在下载… ${Math.round(pct * 100)}%${expectedSize ? ` / ${formatBytes(expectedSize)}` : ''}`
          );
        }
      );

      const result = await downloadResumableRef.current.downloadAsync();
      downloadResumableRef.current = null;
      if (!result) {
        throw new Error('下载失败，请检查网络');
      }

      // 校验：APK 文件至少大于 1MB，且大小与 GitHub 声明一致（允许 ±1% 误差）
      const fileInfo = await FileSystem.getInfoAsync(result.uri);
      if (!fileInfo.exists || fileInfo.size < 1024 * 1024) {
        throw new Error('下载文件异常，请重试');
      }
      if (expectedSize && expectedSize > 0 && fileInfo.size) {
        const ratio = fileInfo.size / expectedSize;
        if (ratio < 0.99 || ratio > 1.01) {
          throw new Error(`文件大小校验失败，请重试（${formatBytes(fileInfo.size)} / ${formatBytes(expectedSize)}）`);
        }
      }

      setDownloadStatus('下载完成，清理缓存并准备安装…');
      setDownloadProgress(1);

      // 安装前清理应用自身缓存（保留刚下载的 APK），释放空间并减少旧数据干扰。
      await cleanAppCache(fileName);
      await cleanUpdateCache(fileName);

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
      if (interactive) {
        Alert.alert(
          '更新失败',
          `${String(e)}\n\n可能原因：\n1. 未开启"允许安装未知应用"权限\n2. 下载链接无法访问\n3. 存储空间不足\n\n建议先开启安装未知应用权限后再试。`,
          [
            { text: '取消', style: 'cancel' },
            {
              text: '去开启',
              onPress: async () => {
                try {
                  if (Platform.Version && Number(Platform.Version) >= 26) {
                    await IntentLauncher.startActivityAsync('android.settings.MANAGE_UNKNOWN_APP_SOURCES', {
                      data: 'package:com.snoresleep.monitor',
                    });
                  } else {
                    Linking.openSettings();
                  }
                } catch {
                  Linking.openSettings();
                }
              },
            },
            { text: '浏览器下载', onPress: () => openUpdateUrl(url) },
          ]
        );
      }
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
          durationSeconds: s.durationSeconds || 1,
          talkCount: s.talkCount ?? 0,
          apneaCount: s.apneaCount ?? 0,
          totalTalkSeconds: s.totalTalkSeconds ?? 0,
          totalApneaSeconds: s.totalApneaSeconds ?? 0,
          qualityScore: s.qualityScore ?? 100,
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

  const saveSettings = async (
    nextSnore: number,
    nextGrind: number,
    nextTalk: number,
    nextApnea: number
  ) => {
    try {
      await AsyncStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          snoreThreshold: nextSnore,
          grindThreshold: nextGrind,
          talkThreshold: nextTalk,
          apneaThreshold: nextApnea,
        })
      );
    } catch (e) {
      console.warn('保存设置失败', e);
    }
  };

  const checkPermission = async (): Promise<boolean> => {
    try {
      if (Platform.OS === 'android') {
        const perm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
        if (!perm) {
          Alert.alert('权限错误', '无法获取录音权限常量，请检查系统版本。');
          return false;
        }
        const result = await PermissionsAndroid.request(perm, {
          title: '需要录音权限',
          message: '睡眠监测需要访问麦克风以录制鼾声、磨牙等声音。',
          buttonNeutral: '稍后询问',
          buttonNegative: '取消',
          buttonPositive: '允许',
        });
        return result === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const { status } = await Audio.requestPermissionsAsync();
        return status === 'granted';
      }
    } catch (e) {
      console.error('权限请求失败', e);
      Alert.alert('权限请求失败', '请在系统设置中手动允许麦克风权限。');
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
    // 防止重复启动：UI 状态或原生引用任一处于活跃状态都直接返回
    if (isBusy || isMonitoring || useNativeMeterRef.current || recordingRef.current) return;
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
      await activateKeepAwakeAsync('monitor');

      // 优先使用原生 AudioMeter 模块（Android），失败时自动降级到 expo-av
      let nativeStarted = false;
      if (Platform.OS === 'android' && AudioMeter) {
        try {
          // 把 JS 设置页里的阈值同步给原生模块，保证两端判定一致
          try {
            await AudioMeter.setThresholds(snoreThreshold, grindThreshold, talkThreshold, apneaThreshold);
          } catch (thresholdErr) {
            console.warn('同步阈值到原生模块失败', thresholdErr);
          }
          // 原生模块：用 AudioRecord 录音 + YAMNet 模型实时推理
          const recordingUri = await AudioMeter.startRecording();
          recordingUriRef.current = recordingUri;
          useNativeMeterRef.current = true;
          nativeStarted = true;
          setIsFallbackMode(false);
        } catch (nativeErr) {
          console.warn('原生 AudioMeter 启动失败，降级到 expo-av', nativeErr);
          useNativeMeterRef.current = false;
          setIsFallbackMode(true);
          // 原生模块可能已部分初始化资源，尝试释放避免泄漏。
          try {
            await AudioMeter.stopRecording();
          } catch {
            // ignore
          }
        }
      }
      if (!nativeStarted) {
        useNativeMeterRef.current = false;
        setIsFallbackMode(true);
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
      setSnoreSeconds(0);
      setGrindSeconds(0);
      setTalkSeconds(0);
      setApneaSeconds(0);
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
      setIsMonitoring(true);
    } catch (e) {
      console.error('开始录音失败', e);
      Alert.alert('启动失败', String(e));
      setIsMonitoring(false);
      setIsFallbackMode(false);
      deactivateKeepAwake('monitor').catch(() => {});
    } finally {
      setIsBusy(false);
    }
  };

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

        // 帧级分类：打鼾/梦话/呼吸暂停仍要求是该帧 top 类别；
        // 磨牙放宽为只要置信度超过阈值且高于其它三种事件即可（不必胜过噪音），
        // 因为磨牙通常是短暂的高频摩擦音，很少成为 YAMNet 聚合后的绝对 top。
        const isSnoreFrame = tClass === 'snoring' && sConf >= snoreThreshold;
        const isGrindFrame = gConf >= grindThreshold && gConf >= sConf && gConf >= tConf && gConf >= aConf;
        const isTalkFrame = tClass === 'talking' && tConf >= talkThreshold;
        const isApneaFrame = tClass === 'apnea' && aConf >= apneaThreshold;
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

    // 按类型累计已结束事件时长（毫秒 -> 秒），进行中事件等 finalize 后再归类，避免类型误判。
    const typeMs = (type: SoundEvent['type']) =>
      eventsRef.current.filter((e) => e.type === type).reduce((sum, e) => sum + e.duration, 0);
    setSnoreSeconds(Math.floor(typeMs('snore') / 1000));
    setGrindSeconds(Math.floor(typeMs('grind') / 1000));
    setTalkSeconds(Math.floor(typeMs('talk') / 1000));
    setApneaSeconds(Math.floor(typeMs('apnea') / 1000));
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
    } else if (grindRatio >= 0.3 && duration >= MIN_GRIND_MS && duration <= MAX_GRIND_MS) {
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

      setSessions((prev) => [session, ...prev]);
    } catch (e) {
      console.error('停止监测失败', e);
      Alert.alert('保存失败', String(e));
    }

    useNativeMeterRef.current = false;
    recordingUriRef.current = '';
    setIsMonitoring(false);
    setIsBusy(false);
    setIsFallbackMode(false);
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
    setSnoreSeconds(0);
    setGrindSeconds(0);
    setTalkSeconds(0);
    setApneaSeconds(0);
    deactivateKeepAwake('monitor').catch(() => {});
  };

  const deleteSession = async (id: string) => {
    await stopPlayback();
    const session = sessions.find((s) => s.id === id);
    if (session?.recordingUri) {
      try {
        await FileSystem.deleteAsync(session.recordingUri, { idempotent: true });
      } catch (e) {
        console.warn('删除录音失败', e);
      }
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
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

  // 切后台/息屏时不再停止监测：AudioForegroundService 会保持录音存活。
  // 组件真正卸载时（应用被杀死或页面关闭）再由下方 cleanup effect 收尾。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (isMonitoring) {
          // 前台服务会持有麦克风并显示通知，用户回到前台时界面继续刷新即可。
          console.log('App moved to background while monitoring; foreground service keeps recording.');
        }
      }
    });
    return () => subscription.remove();
  }, [isMonitoring]);

  useEffect(() => {
    if (screen !== 'detail') {
      stopPlayback().catch(() => {});
    }
  }, [screen]);

  // sessions 变化时自动持久化，避免 stopMonitoring / deleteSession 里直接写存储。
  const isInitialSessionsRef = useRef(true);
  useEffect(() => {
    if (isInitialSessionsRef.current) {
      isInitialSessionsRef.current = false;
      return;
    }
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)).catch((e) => {
      console.warn('保存历史记录失败', e);
    });
  }, [sessions]);

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
      deactivateKeepAwake('monitor').catch(() => {});
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
    <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
      {/* 顶部标题区 */}
      <View style={styles.heroCard}>
        <View style={styles.heroAccentBar} />
        <View style={styles.heroHeader}>
          <View style={styles.appIconCircle}>
            <Ionicons name="moon" size={26} color="#fff" />
          </View>
          <View style={styles.heroTitleBlock}>
            <Text style={styles.title}>睡眠监测</Text>
            <Text style={styles.subtitle}>v{CURRENT_VERSION} · 守护整晚安睡</Text>
          </View>
          {updateCheckState === 'available' && latestRelease && (
            <TouchableOpacity
              style={styles.updateBadge}
              onPress={() => promptUpdate(latestRelease)}
              activeOpacity={0.8}
            >
              <Ionicons name="arrow-up-circle" size={14} color="#fff" />
              <Text style={styles.updateBadgeText}>新版</Text>
            </TouchableOpacity>
          )}
        </View>

        {hasPermission === false && (
          <View style={styles.warningBox}>
            <Ionicons name="warning-outline" size={20} color="#E65100" />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.warningText}>未获得麦克风权限，无法录音。</Text>
            </View>
            <TouchableOpacity
              style={styles.warningButton}
              onPress={async () => setHasPermission(await checkPermission())}
            >
              <Text style={styles.warningButtonText}>去授权</Text>
            </TouchableOpacity>
          </View>
        )}

        {isFallbackMode && (
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={20} color="#0066CC" />
            <Text style={styles.infoText}>
              兼容模式：仅检测音量，不区分鼾声/磨牙等事件。
            </Text>
          </View>
        )}

        {/* 计时器 */}
        <View style={styles.timerBox}>
          <View style={styles.timerPill}>
            <View style={[styles.timerDot, { backgroundColor: isMonitoring ? THEME.danger : THEME.textTertiary }]} />
            <Text style={styles.timerLabel}>{isMonitoring ? '监测中' : '待机'}</Text>
          </View>
          <Text style={styles.timerValue}>{formatDuration(elapsedSeconds)}</Text>
        </View>

        {/* 四类统计卡片 */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${THEME.snore}18` }]}>
              <Ionicons name="volume-high" size={20} color={THEME.snore} />
            </View>
            <Text style={styles.statValue}>{snoreCount}</Text>
            <Text style={styles.statLabel}>打鼾</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${THEME.grind}18` }]}>
              <Ionicons name="git-branch" size={20} color={THEME.grind} />
            </View>
            <Text style={styles.statValue}>{grindCount}</Text>
            <Text style={styles.statLabel}>磨牙</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${THEME.talk}18` }]}>
              <Ionicons name="chatbubble" size={20} color={THEME.talk} />
            </View>
            <Text style={styles.statValue}>{talkCount}</Text>
            <Text style={styles.statLabel}>梦话</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${THEME.apnea}18` }]}>
              <Ionicons name="pulse" size={20} color={THEME.apnea} />
            </View>
            <Text style={styles.statValue}>{apneaCount}</Text>
            <Text style={styles.statLabel}>呼吸暂停</Text>
          </View>
        </View>

        {/* 实时音量区域 */}
        <View style={styles.volumeBox}>
          <View style={styles.volumeHeader}>
            <Text style={styles.volumeLabel}>实时音量</Text>
            <View style={[styles.badge, { backgroundColor: `${THEME.snore}15` }]}>
              <Text style={[styles.badgeText, { color: THEME.snore }]}>鼾声阈值 {(snoreThreshold * 100).toFixed(0)}%</Text>
            </View>
          </View>
          <View style={styles.volumeBarBg}>
            <View
              style={[
                styles.volumeBarFill,
                {
                  width: `${Math.min(100, Math.max(0, (volumeDb + 80) / 80 * 100))}%`,
                  backgroundColor: isSnoringNow ? THEME.danger : THEME.primary,
                },
              ]}
            />
          </View>
          <View style={styles.volumeRow}>
            <Text style={styles.volumeDb}>{volumeDb.toFixed(1)} dB</Text>
            <Text style={[styles.volumeState, { color: isSnoringNow ? THEME.danger : THEME.textSecondary }]}>
              {isSnoringNow ? '● 检测到声音' : '○ 环境安静'}
            </Text>
          </View>

          {/* AI 模型置信度 - 分卡片展示 */}
          {!isFallbackMode && (
            <View style={styles.confidenceGrid}>
              <View style={[styles.confidenceChip, { backgroundColor: `${THEME.snore}12` }]}>
                <Text style={[styles.confidenceLabel, { color: THEME.snore }]}>打鼾</Text>
                <Text style={[styles.confidenceValue, { color: THEME.snore }]}>{(snoreConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${THEME.grind}12` }]}>
                <Text style={[styles.confidenceLabel, { color: THEME.grind }]}>磨牙</Text>
                <Text style={[styles.confidenceValue, { color: THEME.grind }]}>{(grindConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${THEME.talk}12` }]}>
                <Text style={[styles.confidenceLabel, { color: THEME.talk }]}>梦话</Text>
                <Text style={[styles.confidenceValue, { color: THEME.talk }]}>{(talkConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${THEME.apnea}12` }]}>
                <Text style={[styles.confidenceLabel, { color: THEME.apnea }]}>暂停</Text>
                <Text style={[styles.confidenceValue, { color: THEME.apnea }]}>{(apneaConfidence * 100).toFixed(0)}%</Text>
              </View>
            </View>
          )}

          {/* 当前识别类别 */}
          {!isFallbackMode && (
            <View style={styles.topClassRow}>
              <Ionicons name="analytics" size={14} color={THEME.textTertiary} />
              <Text style={styles.topClassText}>
                当前识别：{getClassLabel(topClass)} {(topConfidence * 100).toFixed(0)}%
              </Text>
            </View>
          )}

          {snoreIntensity && (
            <View style={[styles.intensityBadge, { backgroundColor: getIntensityColor(snoreIntensity) + '20' }]}>
              <Ionicons name="alert-circle" size={14} color={getIntensityColor(snoreIntensity)} />
              <Text style={[styles.intensityText, { color: getIntensityColor(snoreIntensity) }]}>
                鼾声强度：{getIntensityLabel(snoreIntensity)}
              </Text>
            </View>
          )}

          <View style={styles.maxVolumeRow}>
            <Ionicons name="trophy-outline" size={13} color={THEME.warning} />
            <Text style={[styles.volumeDb, { color: THEME.warning, marginLeft: 4 }]}>
              本次最大：{maxVolumeDb > -100 ? maxVolumeDb.toFixed(1) + ' dB' : '--'}
            </Text>
          </View>
          <View style={[styles.maxVolumeRow, { marginTop: 4 }]}>
            <Ionicons name="time-outline" size={13} color={THEME.textSecondary} />
            <Text style={[styles.volumeDb, { color: THEME.textSecondary, marginLeft: 4 }]}>
              声音时长：{formatDuration(totalNoiseSeconds)}
            </Text>
          </View>

          {/* 各类事件累计时长 */}
          <View style={styles.durationRow}>
            <View style={styles.durationItem}>
              <View style={[styles.durationDot, { backgroundColor: THEME.snore }]} />
              <Text style={styles.durationLabel}>鼾声 {formatDuration(snoreSeconds)}</Text>
            </View>
            <View style={styles.durationItem}>
              <View style={[styles.durationDot, { backgroundColor: THEME.grind }]} />
              <Text style={styles.durationLabel}>磨牙 {formatDuration(grindSeconds)}</Text>
            </View>
            <View style={styles.durationItem}>
              <View style={[styles.durationDot, { backgroundColor: THEME.talk }]} />
              <Text style={styles.durationLabel}>梦话 {formatDuration(talkSeconds)}</Text>
            </View>
            <View style={styles.durationItem}>
              <View style={[styles.durationDot, { backgroundColor: THEME.apnea }]} />
              <Text style={styles.durationLabel}>暂停 {formatDuration(apneaSeconds)}</Text>
            </View>
          </View>
        </View>

        {/* 主按钮 */}
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
            <>
              <Ionicons
                name={isMonitoring ? 'stop-circle' : 'play-circle'}
                size={22}
                color="#fff"
                style={{ marginRight: 8 }}
              />
              <Text style={styles.mainButtonText}>
                {isMonitoring ? '停止监测' : '开始睡眠监测'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {isMonitoring && (
          <View style={styles.tipRow}>
            <Ionicons name="battery-charging" size={13} color={THEME.textTertiary} />
            <Text style={styles.tipText}>监测中 · 已启用后台录音，可息屏运行，建议连接充电器</Text>
          </View>
        )}
      </View>

      {/* 底部导航 */}
      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('history')} activeOpacity={0.85}>
          <View style={[styles.navIconCircle, { backgroundColor: `${THEME.primary}15` }]}>
            <Ionicons name="time" size={22} color={THEME.primary} />
          </View>
          <Text style={styles.navButtonText}>历史记录</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('settings')} activeOpacity={0.85}>
          <View style={[styles.navIconCircle, { backgroundColor: `${THEME.primary}15` }]}>
            <Ionicons name="settings" size={22} color={THEME.primary} />
          </View>
          <Text style={styles.navButtonText}>灵敏度设置</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderHistory = () => (
    <View style={styles.flex}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={THEME.primary} />
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
            <View style={styles.emptyIconCircle}>
              <Ionicons name="bed-outline" size={48} color={THEME.primary} />
            </View>
            <Text style={styles.emptyText}>暂无睡眠记录</Text>
            <Text style={styles.emptySubText}>点击首页“开始睡眠监测”，记录整晚声音</Text>
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
            activeOpacity={0.85}
          >
            <View style={styles.historyRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTime}>{formatTime(item.startTime)}</Text>
                <View style={styles.historyMetaRow}>
                  <Ionicons name="time-outline" size={14} color={THEME.textTertiary} />
                  <Text style={styles.historyMeta}>睡眠 {formatDuration(item.durationSeconds)}</Text>
                </View>
                <View style={styles.historyCountRow}>
                  <View style={[styles.historyCount, { backgroundColor: `${THEME.snore}15` }]}>
                    <Ionicons name="volume-high-outline" size={14} color={THEME.snore} />
                    <Text style={[styles.historyCountText, { color: THEME.snore }]}>{item.snoreCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${THEME.grind}15` }]}>
                    <Ionicons name="git-branch-outline" size={14} color={THEME.grind} />
                    <Text style={[styles.historyCountText, { color: THEME.grind }]}>{item.grindCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${THEME.talk}15` }]}>
                    <Ionicons name="chatbubble-outline" size={14} color={THEME.talk} />
                    <Text style={[styles.historyCountText, { color: THEME.talk }]}>{item.talkCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${THEME.apnea}15` }]}>
                    <Ionicons name="pulse-outline" size={14} color={THEME.apnea} />
                    <Text style={[styles.historyCountText, { color: THEME.apnea }]}>{item.apneaCount}</Text>
                  </View>
                </View>
              </View>
              <View style={[styles.qualityBadge, { backgroundColor: getQualityColor(item.qualityScore) }]}>
                <Text style={styles.qualityText}>{item.qualityScore}分</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={THEME.textTertiary} style={{ marginLeft: 8 }} />
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
            <Ionicons name="chevron-back" size={26} color={THEME.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>记录详情</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.card}>
          <View style={styles.detailHeader}>
            <View style={[styles.detailIconCircle, { backgroundColor: `${THEME.primary}15` }]}>
              <Ionicons name="moon-outline" size={24} color={THEME.primary} />
            </View>
            <View>
              <Text style={styles.detailTime}>{formatTime(selectedSession.startTime)}</Text>
              <Text style={styles.detailSubTime}>睡眠时长 {formatDuration(selectedSession.durationSeconds)}</Text>
            </View>
          </View>

          <View style={styles.detailStatsGrid}>
            <View style={styles.detailStatCard}>
              <Ionicons name="time-outline" size={20} color={THEME.primary} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.durationSeconds)}</Text>
              <Text style={styles.detailStatLabel}>睡眠时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="volume-high-outline" size={20} color={THEME.snore} />
              <Text style={styles.detailStatValue}>{selectedSession.snoreCount}</Text>
              <Text style={styles.detailStatLabel}>打鼾</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="git-branch-outline" size={20} color={THEME.grind} />
              <Text style={styles.detailStatValue}>{selectedSession.grindCount}</Text>
              <Text style={styles.detailStatLabel}>磨牙</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="chatbubble-outline" size={20} color={THEME.talk} />
              <Text style={styles.detailStatValue}>{selectedSession.talkCount}</Text>
              <Text style={styles.detailStatLabel}>梦话</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="pulse-outline" size={20} color={THEME.apnea} />
              <Text style={styles.detailStatValue}>{selectedSession.apneaCount}</Text>
              <Text style={styles.detailStatLabel}>呼吸暂停</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="volume-medium-outline" size={20} color={THEME.warning} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalSnoreSeconds)}</Text>
              <Text style={styles.detailStatLabel}>鼾声时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="git-branch-outline" size={20} color={THEME.grind} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalGrindSeconds)}</Text>
              <Text style={styles.detailStatLabel}>磨牙时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="chatbubble-outline" size={20} color={THEME.talk} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalTalkSeconds)}</Text>
              <Text style={styles.detailStatLabel}>梦话时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="pulse-outline" size={20} color={THEME.apnea} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalApneaSeconds)}</Text>
              <Text style={styles.detailStatLabel}>呼吸暂停时长</Text>
            </View>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getQualityColor(selectedSession.qualityScore), marginBottom: 10 }]}>
            <Text style={styles.qualityTextLarge}>睡眠质量 {selectedSession.qualityScore} 分</Text>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getApneaRiskColor(selectedSession.apneaRisk || 'low') }]}>
            <Text style={styles.qualityTextLarge}>呼吸暂停风险 {getApneaRiskLabel(selectedSession.apneaRisk || 'low')}</Text>
          </View>

          {selectedSession.intensityBreakdown && selectedSession.snoreCount > 0 && (
            <View style={{ marginBottom: 24 }}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="stats-chart-outline" size={16} color={THEME.text} /> 鼾声强度分布
              </Text>
              <View style={styles.intensityRow}>
                <View style={[styles.intensityBlock, { backgroundColor: `${THEME.success}20` }]}>
                  <Text style={[styles.detailStatValue, { color: THEME.success }]}>{selectedSession.intensityBreakdown.mild}</Text>
                  <Text style={styles.detailStatLabel}>轻度</Text>
                </View>
                <View style={[styles.intensityBlock, { backgroundColor: `${THEME.warning}20` }]}>
                  <Text style={[styles.detailStatValue, { color: THEME.warning }]}>{selectedSession.intensityBreakdown.moderate}</Text>
                  <Text style={styles.detailStatLabel}>中度</Text>
                </View>
                <View style={[styles.intensityBlock, { backgroundColor: `${THEME.danger}20` }]}>
                  <Text style={[styles.detailStatValue, { color: THEME.danger }]}>{selectedSession.intensityBreakdown.severe}</Text>
                  <Text style={styles.detailStatLabel}>重度</Text>
                </View>
              </View>
            </View>
          )}

          {selectedSession.recordingUri ? (
            <View style={styles.recordingBox}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="mic-outline" size={16} color={THEME.text} /> 录音回放
              </Text>
              <TouchableOpacity
                style={[styles.mainButton, isPlaying ? styles.stopButton : styles.startButton]}
                onPress={() =>
                  isPlaying ? stopPlayback() : playRecording(selectedSession.recordingUri!)
                }
              >
                <Ionicons name={isPlaying ? 'square' : 'play'} size={18} color="#fff" style={{ marginRight: 8 }} />
                <Text style={styles.mainButtonText}>{isPlaying ? '停止播放' : '播放录音'}</Text>
              </TouchableOpacity>
              {playbackDurMs > 0 && (
                <View style={{ marginTop: 16 }}>
                  <View style={styles.volumeBarBg}>
                    <View
                      style={[
                        styles.volumeBarFill,
                        {
                          width: `${Math.min(100, (playbackPosMs / playbackDurMs) * 100)}%`,
                          backgroundColor: THEME.primary,
                        },
                      ]}
                    />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={styles.volumeDb}>{formatDuration(Math.floor(playbackPosMs / 1000))}</Text>
                    <Text style={styles.volumeDb}>{formatDuration(Math.floor(playbackDurMs / 1000))}</Text>
                  </View>
                </View>
              )}
            </View>
          ) : (
            <View style={styles.emptyRecordingBox}>
              <Ionicons name="mic-off-outline" size={32} color={THEME.textTertiary} />
              <Text style={styles.noRecordingText}>未保存录音</Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>
            <Ionicons name="list-outline" size={16} color={THEME.text} /> 异常声音事件
          </Text>
          {selectedSession.events.length === 0 ? (
            <View style={styles.emptyEventBox}>
              <View style={[styles.eventIconCircle, { backgroundColor: `${THEME.success}15` }]}>
                <Ionicons name="checkmark-circle-outline" size={24} color={THEME.success} />
              </View>
              <Text style={styles.noRecordingText}>未检测到异常声音事件</Text>
            </View>
          ) : (
            <View style={styles.timeline}>
              {selectedSession.events.map((evt, idx) => {
                const absStart = selectedSession.startTime + evt.start;
                const isCurrent =
                  isPlaying && playbackPosMs >= evt.start - 500 && playbackPosMs <= evt.end + 500;
                const iconName =
                  evt.type === 'snore' ? 'volume-high-outline' :
                  evt.type === 'grind' ? 'git-branch-outline' :
                  evt.type === 'talk' ? 'chatbubble-outline' : 'pulse-outline';
                return (
                  <TouchableOpacity
                    key={idx}
                    style={[
                      styles.eventRow,
                      { borderLeftColor: getEventColor(evt.type) },
                      isCurrent ? { backgroundColor: `${THEME.primary}12` } : {},
                    ]}
                    onPress={() => selectedSession.recordingUri && seekToEvent(evt)}
                    disabled={!selectedSession.recordingUri}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.eventIconCircle, { backgroundColor: `${getEventColor(evt.type)}15` }]}>
                      <Ionicons name={iconName as any} size={18} color={getEventColor(evt.type)} />
                    </View>
                    <View style={styles.eventBody}>
                      <Text style={[styles.eventIndex, { color: getEventColor(evt.type) }]}>
                        #{idx + 1} {getEventLabel(evt.type, evt.intensity)}
                      </Text>
                      <Text style={styles.eventClock}>{formatClock(absStart)} · {(evt.duration / 1000).toFixed(1)}秒</Text>
                    </View>
                    {selectedSession.recordingUri && (
                      <Ionicons name="play-circle-outline" size={24} color={THEME.primary} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <View style={{ height: 16 }} />
          <TouchableOpacity
            style={[styles.mainButton, styles.stopButton]}
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
          >
            <Ionicons name="trash-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.mainButtonText}>删除此记录</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  };

  const renderSettings = () => (
    <ScrollView style={styles.flex} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={THEME.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>设置</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.card}>
        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.snore}20` }]}>
              <Ionicons name="volume-high-outline" size={20} color={THEME.snore} />
            </View>
            <Text style={styles.sectionTitle}>鼾声检测阈值</Text>
          </View>
          <Text style={styles.settingsDesc}>
            YAMNet 模型聚合出“打鼾 / 磨牙 / 梦话 / 呼吸暂停 / 噪音”五类置信度。只有当“打鼾”置信度不低于该阈值，且连续满足条件达到最小持续时间，才会被记录为一次打鼾。推荐 40%–60%。
          </Text>
          <Text style={styles.thresholdValue}>{(snoreThreshold * 100).toFixed(0)}%</Text>
          <View style={styles.sliderRow}>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.snore}20` }]}
              onPress={() => {
                const val = Math.max(0.1, parseFloat((snoreThreshold - 0.05).toFixed(2)));
                setSnoreThreshold(val);
                saveSettings(val, grindThreshold, talkThreshold, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.snore }]}>-</Text>
            </TouchableOpacity>
            <View style={styles.thresholdTrack}>
              <View
                style={[
                  styles.thresholdFill,
                  { width: `${((snoreThreshold - 0.1) / 0.8) * 100}%`, backgroundColor: THEME.snore },
                ]}
              />
            </View>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.snore}20` }]}
              onPress={() => {
                const val = Math.min(0.9, parseFloat((snoreThreshold + 0.05).toFixed(2)));
                setSnoreThreshold(val);
                saveSettings(val, grindThreshold, talkThreshold, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.snore }]}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.grind}20` }]}>
              <Ionicons name="git-branch-outline" size={20} color={THEME.grind} />
            </View>
            <Text style={styles.sectionTitle}>磨牙检测阈值</Text>
          </View>
          <Text style={styles.settingsDesc}>
            通过“咀嚼 / 咬合 / 摩擦”类声音识别磨牙候选。当“磨牙”聚合置信度不低于该阈值，且事件持续时间在 0.3–1.5 秒之间，才会被记录。推荐 30%–45%。
          </Text>
          <Text style={styles.thresholdValue}>{(grindThreshold * 100).toFixed(0)}%</Text>
          <View style={styles.sliderRow}>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.grind}20` }]}
              onPress={() => {
                const val = Math.max(0.1, parseFloat((grindThreshold - 0.05).toFixed(2)));
                setGrindThreshold(val);
                saveSettings(snoreThreshold, val, talkThreshold, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.grind }]}>-</Text>
            </TouchableOpacity>
            <View style={styles.thresholdTrack}>
              <View
                style={[
                  styles.thresholdFill,
                  { width: `${((grindThreshold - 0.1) / 0.8) * 100}%`, backgroundColor: THEME.grind },
                ]}
              />
            </View>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.grind}20` }]}
              onPress={() => {
                const val = Math.min(0.9, parseFloat((grindThreshold + 0.05).toFixed(2)));
                setGrindThreshold(val);
                saveSettings(snoreThreshold, val, talkThreshold, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.grind }]}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.talk}20` }]}>
              <Ionicons name="chatbubble-outline" size={20} color={THEME.talk} />
            </View>
            <Text style={styles.sectionTitle}>梦话检测阈值</Text>
          </View>
          <Text style={styles.settingsDesc}>
            当“说话 / 对话 / 低语”等语音类聚合置信度不低于该阈值，且事件持续时间达到最小值，才会被记录为一次梦话。推荐 45%–60%。
          </Text>
          <Text style={styles.thresholdValue}>{(talkThreshold * 100).toFixed(0)}%</Text>
          <View style={styles.sliderRow}>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.talk}20` }]}
              onPress={() => {
                const val = Math.max(0.1, parseFloat((talkThreshold - 0.05).toFixed(2)));
                setTalkThreshold(val);
                saveSettings(snoreThreshold, grindThreshold, val, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.talk }]}>-</Text>
            </TouchableOpacity>
            <View style={styles.thresholdTrack}>
              <View
                style={[
                  styles.thresholdFill,
                  { width: `${((talkThreshold - 0.1) / 0.8) * 100}%`, backgroundColor: THEME.talk },
                ]}
              />
            </View>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.talk}20` }]}
              onPress={() => {
                const val = Math.min(0.9, parseFloat((talkThreshold + 0.05).toFixed(2)));
                setTalkThreshold(val);
                saveSettings(snoreThreshold, grindThreshold, val, apneaThreshold);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.talk }]}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.apnea}20` }]}>
              <Ionicons name="pulse-outline" size={20} color={THEME.apnea} />
            </View>
            <Text style={styles.sectionTitle}>呼吸暂停检测阈值</Text>
          </View>
          <Text style={styles.settingsDesc}>
            当“喘息 / 喘气 / 喷气”等异常呼吸类聚合置信度不低于该阈值，且事件持续 0.2–2.0 秒，才会被记录为一次呼吸暂停候选。推荐 40%–55%。
          </Text>
          <Text style={styles.thresholdValue}>{(apneaThreshold * 100).toFixed(0)}%</Text>
          <View style={styles.sliderRow}>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.apnea}20` }]}
              onPress={() => {
                const val = Math.max(0.1, parseFloat((apneaThreshold - 0.05).toFixed(2)));
                setApneaThreshold(val);
                saveSettings(snoreThreshold, grindThreshold, talkThreshold, val);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.apnea }]}>-</Text>
            </TouchableOpacity>
            <View style={styles.thresholdTrack}>
              <View
                style={[
                  styles.thresholdFill,
                  { width: `${((apneaThreshold - 0.1) / 0.8) * 100}%`, backgroundColor: THEME.apnea },
                ]}
              />
            </View>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${THEME.apnea}20` }]}
              onPress={() => {
                const val = Math.min(0.9, parseFloat((apneaThreshold + 0.05).toFixed(2)));
                setApneaThreshold(val);
                saveSettings(snoreThreshold, grindThreshold, talkThreshold, val);
              }}
            >
              <Text style={[styles.adjustButtonText, { color: THEME.apnea }]}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.mainButton, { backgroundColor: THEME.textTertiary, marginTop: 8 }]}
          onPress={() => {
            setSnoreThreshold(DEFAULT_SNORE_CONFIDENCE);
            setGrindThreshold(DEFAULT_GRIND_CONFIDENCE);
            setTalkThreshold(DEFAULT_TALK_CONFIDENCE);
            setApneaThreshold(DEFAULT_APNEA_CONFIDENCE);
            saveSettings(DEFAULT_SNORE_CONFIDENCE, DEFAULT_GRIND_CONFIDENCE, DEFAULT_TALK_CONFIDENCE, DEFAULT_APNEA_CONFIDENCE);
          }}
        >
          <Ionicons name="refresh-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.mainButtonText}>恢复默认</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { marginTop: 16 }]}>
        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.primary}20` }]}>
              <Ionicons name="cloud-download-outline" size={20} color={THEME.primary} />
            </View>
            <Text style={styles.sectionTitle}>应用更新</Text>
          </View>
          <View style={styles.versionRow}>
            <Text style={styles.settingsDesc}>当前版本 {CURRENT_VERSION}</Text>
            {updateCheckState === 'available' && latestRelease && (
              <View style={styles.newVersionBadge}>
                <Text style={styles.newVersionBadgeText}>可更新至 {latestRelease.version}</Text>
              </View>
            )}
          </View>
          {updateCheckState === 'available' && latestRelease && (
            <TouchableOpacity
              style={[styles.mainButton, styles.startButton, { marginBottom: 12 }]}
              onPress={() => downloadAndInstallApk(latestRelease.downloadUrl)}
            >
              <Ionicons name="download-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.mainButtonText}>下载最新版本 APK</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.mainButton,
              updateCheckState === 'checking' && { opacity: 0.6 },
              { backgroundColor: THEME.primary },
            ]}
            onPress={() => checkUpdate(true)}
            disabled={updateCheckState === 'checking'}
          >
            <Ionicons name="refresh-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.mainButtonText}>
              {updateCheckState === 'checking' ? '检查中…' : '检查更新'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.card, { marginTop: 16 }]}>
        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${THEME.warning}20` }]}>
              <Ionicons name="trash-outline" size={20} color={THEME.warning} />
            </View>
            <Text style={styles.sectionTitle}>存储空间</Text>
          </View>
          <Text style={styles.settingsDesc}>
            清理过期的录音和临时缓存文件，释放手机存储空间（历史记录不会被删除）。
          </Text>
          <TouchableOpacity
            style={[styles.mainButton, { backgroundColor: THEME.warning }]}
            onPress={async () => {
              try {
                await cleanOldRecordings();
                await cleanAppCache();
                Alert.alert('清理完成', '已清理过期录音和应用缓存。');
              } catch (e) {
                Alert.alert('清理失败', String(e));
              }
            }}
          >
            <Ionicons name="sparkles-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.mainButtonText}>清理缓存</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
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
            <View style={styles.updateIconCircle}>
              <Ionicons name="cloud-download-outline" size={32} color={THEME.primary} />
            </View>
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

function getClassLabel(classKey: string): string {
  switch (classKey) {
    case 'snoring': return '打鼾';
    case 'grinding': return '磨牙';
    case 'talking': return '梦话';
    case 'apnea': return '呼吸暂停';
    case 'noise': return '环境音';
    default: return classKey;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 16,
    color: THEME.textSecondary,
    fontSize: 15,
  },
  flex: {
    flex: 1,
  },
  homeContent: {
    padding: 16,
    paddingTop: 20,
  },
  heroCard: {
    backgroundColor: THEME.card,
    borderRadius: 28,
    padding: 22,
    overflow: 'hidden',
    shadowColor: '#1A2B3C',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 20,
    elevation: 5,
  },
  heroAccentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: THEME.primary,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  appIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: THEME.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: THEME.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: THEME.text,
  },
  subtitle: {
    fontSize: 13,
    color: THEME.textTertiary,
    marginTop: 2,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF3E0',
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
  },
  warningText: {
    color: '#E65100',
    fontSize: 13,
    lineHeight: 18,
  },
  warningButton: {
    backgroundColor: '#E65100',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginLeft: 8,
  },
  warningButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E3F2FD',
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
  },
  infoText: {
    flex: 1,
    color: '#0066CC',
    fontSize: 13,
    lineHeight: 18,
    marginLeft: 12,
  },
  timerBox: {
    alignItems: 'center',
    marginVertical: 16,
  },
  timerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME.background,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  timerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  timerLabel: {
    fontSize: 12,
    color: THEME.textSecondary,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  timerValue: {
    fontSize: 48,
    fontWeight: '200',
    color: THEME.text,
    fontVariant: ['tabular-nums'],
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  statCard: {
    width: (SCREEN_W - 64) / 2,
    backgroundColor: THEME.background,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  statIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  statValue: {
    fontSize: 22,
    fontWeight: '800',
    color: THEME.text,
    fontVariant: ['tabular-nums'],
    marginTop: 6,
  },
  statLabel: {
    fontSize: 12,
    color: THEME.textSecondary,
    marginTop: 2,
  },
  volumeBox: {
    backgroundColor: THEME.background,
    borderRadius: 18,
    padding: 16,
    marginBottom: 20,
  },
  volumeLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: THEME.text,
  },
  volumeBarBg: {
    height: 12,
    backgroundColor: THEME.border,
    borderRadius: 6,
    overflow: 'hidden',
  },
  volumeBarFill: {
    height: '100%',
    borderRadius: 6,
  },
  volumeDb: {
    fontSize: 12,
    color: THEME.textSecondary,
    marginTop: 6,
  },
  badge: {
    backgroundColor: `${THEME.primary}15`,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: THEME.primary,
  },
  confidenceGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  confidenceChip: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    marginHorizontal: 3,
  },
  confidenceLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  confidenceValue: {
    fontSize: 16,
    fontWeight: '800',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  topClassRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: THEME.card,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  topClassText: {
    fontSize: 12,
    color: THEME.textSecondary,
    marginLeft: 6,
    fontWeight: '600',
  },
  intensityText: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 4,
  },
  maxVolumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  durationRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 8,
  },
  durationItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  durationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  durationLabel: {
    fontSize: 11,
    color: THEME.textSecondary,
  },
  intensityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginTop: 8,
  },
  mainButton: {
    borderRadius: 20,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  startButton: {
    backgroundColor: THEME.primary,
  },
  stopButton: {
    backgroundColor: THEME.danger,
  },
  mainButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  tipText: {
    fontSize: 12,
    color: THEME.textTertiary,
    marginLeft: 6,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  navButton: {
    backgroundColor: THEME.card,
    borderRadius: 20,
    paddingVertical: 16,
    flex: 1,
    marginHorizontal: 6,
    alignItems: 'center',
    shadowColor: '#1A2B3C',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  navIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  navButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: THEME.text,
    marginTop: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: (RNStatusBar.currentHeight || 0) + 12,
    paddingBottom: 12,
    backgroundColor: THEME.card,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: THEME.text,
  },
  emptyBox: {
    alignItems: 'center',
    marginTop: 80,
  },
  emptyText: {
    color: THEME.textSecondary,
    fontSize: 17,
    fontWeight: '700',
    marginTop: 16,
  },
  emptySubText: {
    color: THEME.textTertiary,
    fontSize: 13,
    marginTop: 6,
  },
  historyItem: {
    backgroundColor: THEME.card,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#1A2B3C',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyTime: {
    fontSize: 16,
    fontWeight: '700',
    color: THEME.text,
  },
  historyMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  historyMeta: {
    fontSize: 13,
    color: THEME.textSecondary,
    marginLeft: 4,
  },
  historyCountRow: {
    flexDirection: 'row',
    marginTop: 10,
  },
  historyCount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME.background,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginRight: 8,
  },
  historyCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: THEME.text,
    marginLeft: 4,
  },
  qualityBadge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  qualityText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  card: {
    backgroundColor: THEME.card,
    borderRadius: 24,
    padding: 20,
    shadowColor: '#1A2B3C',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  detailTime: {
    flex: 1,
    fontSize: 18,
    fontWeight: '800',
    color: THEME.text,
    textAlign: 'center',
    marginBottom: 18,
  },
  detailStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  detailStatCard: {
    width: (SCREEN_W - 72) / 3,
    backgroundColor: THEME.background,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  detailStat: {
    alignItems: 'center',
  },
  detailStatValue: {
    fontSize: 16,
    fontWeight: '800',
    color: THEME.text,
    fontVariant: ['tabular-nums'],
    marginTop: 6,
  },
  detailStatLabel: {
    fontSize: 11,
    color: THEME.textSecondary,
    marginTop: 2,
  },
  qualityBadgeLarge: {
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 14,
  },
  qualityTextLarge: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  intensityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  intensityBlock: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    marginHorizontal: 4,
  },
  recordingBox: {
    marginBottom: 24,
  },
  emptyRecordingBox: {
    alignItems: 'center',
    backgroundColor: THEME.background,
    borderRadius: 16,
    paddingVertical: 24,
    marginBottom: 24,
  },
  emptyEventBox: {
    alignItems: 'center',
    backgroundColor: '#2ECC7115',
    borderRadius: 16,
    paddingVertical: 24,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: THEME.text,
    marginBottom: 12,
  },
  noRecordingText: {
    color: THEME.textSecondary,
    fontSize: 13,
    marginTop: 8,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    backgroundColor: THEME.card,
    borderRadius: 14,
    marginBottom: 10,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  eventIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventIndex: {
    color: THEME.primary,
    fontWeight: '700',
    fontSize: 13,
  },
  eventClock: {
    color: THEME.textSecondary,
    fontSize: 12,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  settingsDesc: {
    fontSize: 13,
    color: THEME.textSecondary,
    lineHeight: 19,
    marginBottom: 12,
  },
  settingSection: {
    marginBottom: 8,
  },
  settingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  settingIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  thresholdValue: {
    fontSize: 36,
    fontWeight: '800',
    color: THEME.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  adjustButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: THEME.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adjustButtonText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 26,
  },
  thresholdTrack: {
    flex: 1,
    height: 8,
    backgroundColor: THEME.border,
    borderRadius: 4,
    marginHorizontal: 14,
    overflow: 'hidden',
  },
  thresholdFill: {
    height: '100%',
    borderRadius: 4,
  },
  divider: {
    height: 1,
    backgroundColor: THEME.border,
    marginVertical: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  updateModal: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: THEME.card,
    borderRadius: 24,
    padding: 26,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  updateIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 22,
    backgroundColor: `${THEME.primary}15`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  updateModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: THEME.text,
    marginBottom: 6,
  },
  updateModalStatus: {
    fontSize: 13,
    color: THEME.textSecondary,
    marginBottom: 18,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    backgroundColor: THEME.border,
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressFill: {
    height: '100%',
    backgroundColor: THEME.primary,
    borderRadius: 5,
  },
  updateModalPercent: {
    fontSize: 16,
    fontWeight: '800',
    color: THEME.primary,
  },
  heroTitleBlock: {
    flex: 1,
    marginLeft: 14,
  },
  updateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME.danger,
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 10,
    shadowColor: THEME.danger,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  updateBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 4,
  },
  volumeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  volumeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  volumeState: {
    fontSize: 12,
    marginTop: 6,
    fontWeight: '700',
  },
  emptyIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 32,
    backgroundColor: `${THEME.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  detailIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  detailSubTime: {
    fontSize: 13,
    color: THEME.textSecondary,
    marginTop: 2,
  },
  timeline: {
    marginTop: 4,
  },
  eventBody: {
    flex: 1,
    marginLeft: 12,
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  newVersionBadge: {
    backgroundColor: `${THEME.danger}15`,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  newVersionBadgeText: {
    color: THEME.danger,
    fontSize: 12,
    fontWeight: '700',
  },
});
