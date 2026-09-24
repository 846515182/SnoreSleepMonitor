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
  useColorScheme,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

import type { Screen, SleepSession, SoundEvent, ThemePreference } from './src/types';
import { ApneaTracker, apneaMinSilenceMs, type ApneaEvent } from './src/logic/apnea';
import { classifyFinalEvent, classifyIntensity, GRACE_MS } from './src/logic/events';
import { compareVersion } from './src/logic/version';
import { summarizeSession } from './src/logic/session';
import { formatBytes, formatClock, formatDuration, formatTime } from './src/utils/format';
import {
  getApneaRiskColor,
  getApneaRiskLabel,
  getEventColor,
  getEventLabel,
  getClassLabel,
  getIntensityColor,
  getIntensityLabel,
  getQualityColor,
} from './src/utils/labels';
import { resolveTheme } from './src/theme';
import { makeStyles } from './src/styles';

// 原生音频模块（Android 专用：AudioRecord 录音 + YAMNet 本地推理）
const AudioMeter = NativeModules.AudioMeter;

// 领域类型统一定义在 src/types.ts，供 UI / 逻辑 / 单元测试共用。

// 常量
/** 版本号由 app.config.js 从 package.json 注入，消除三处硬编码漂移 */
const CURRENT_VERSION = (Constants.expoConfig?.version as string) || '0.0.0';
const GITHUB_OWNER = '846515182';
const GITHUB_REPO = 'SnoreSleepMonitor';
const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
/** 更新包只接受本仓库 Releases 下发的地址（防止接口被投毒后下载到第三方 APK） */
const EXPECTED_DOWNLOAD_PREFIX = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`;
const PRIVACY_POLICY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/main/PRIVACY.md`;
/** 首次启动同意页与设置页共用的隐私说明（离线可读，避免依赖网络加载） */
const PRIVACY_SUMMARY = [
  '· 录音与声音识别（YAMNet）全部在你的手机上完成，音频不会上传到任何服务器。',
  '· 应用不收集个人身份信息，不接入广告或统计 SDK。',
  '· 录音文件保存在本机缓存中，3 天后自动清理；你也可以随时在设置中清理。',
  '· 历史睡眠记录仅保存在本机，卸载应用即随之删除。',
  '· 仅在你主动点击「检查更新」或收到更新提示时，才会访问本仓库的 GitHub Releases。',
  '',
  '呼吸暂停筛查结果仅供参考，不构成医疗诊断。',
].join('\n');
const STORAGE_KEY = '@snore_sessions_v2';
const SETTINGS_KEY = '@snore_settings_v2';
/** 进行中会话的增量快照：应用被杀 / 手机重启后可恢复整晚数据，避免“白录一晚” */
const ACTIVE_SESSION_KEY = '@snore_active_session_v1';
const CONSENT_KEY = '@snore_privacy_consent_v1';
const THEME_PREF_KEY = '@snore_theme_pref_v1';
/** 每 N 个监测周期写一次快照（CHUNK_MS = 300ms，100 个 ≈ 30 秒） */
const ACTIVE_SNAPSHOT_TICKS = 100;
/** 详情页最多渲染的事件条数：整晚可能上千条，全量渲染会严重卡顿 */
const MAX_VISIBLE_EVENTS = 200;
const CHUNK_MS = 300; // 监测循环周期（更频繁采样）
const DEFAULT_SNORE_CONFIDENCE = 0.45; // 默认鼾声置信度阈值（YAMNet 更准，可适当放宽）
const DEFAULT_GRIND_CONFIDENCE = 0.25; // 默认磨牙置信度阈值（YAMNet 聚合分数）
const DEFAULT_TALK_CONFIDENCE = 0.5; // 默认梦话置信度阈值
const DEFAULT_APNEA_CONFIDENCE = 0.1; // 默认呼吸暂停判定：连续无声 10 秒（滑块 0.1–0.9 映射 10–30 秒）
const FALLBACK_THRESHOLD_DB = -60; // expo-av 回退方案音量阈值
const MAX_RECORDING_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 保留 3 天录音（WAV 约 115MB/小时，避免撑爆存储）
const MAX_EVENTS_PER_SESSION = 1000; // 单次会话事件数上限，防止 AsyncStorage 溢出
const MAX_PERSISTED_SESSIONS = 200; // 历史记录持久化条数上限
const APNEA_SOUND_CONF = 0.45; // YAMNet 异常呼吸音（喘息/喘鸣/喷气）置信度，用于确认一次暂停结束
const MIN_FREE_STORAGE_BYTES = 1500 * 1024 * 1024; // 开始监测前的剩余空间预警线（整晚 WAV 约 1GB）
const MAX_CACHED_APKS = 3; // 最多保留几个更新包

/** 设置页「检测阈值」分段切换的四类事件 */
type ThresholdTab = 'snore' | 'grind' | 'talk' | 'apnea';

/**
 * 四类阈值集成到一个调节区分段切换：原先四个大区块（各带长文案+大滑条）
 * 把设置页拉得很长，合并后只渲染当前选中的一类。
 */
const THRESHOLD_TABS: Array<{ key: ThresholdTab; label: string; desc: string }> = [
  { key: 'snore', label: '打鼾', desc: '“打鼾”置信度达到该阈值且持续达标才记录一次，推荐 40%–60%。' },
  { key: 'grind', label: '磨牙', desc: '“磨牙”置信度达到该阈值且事件持续 0.3–1.5 秒才记录，推荐 30%–45%。' },
  { key: 'talk', label: '梦话', desc: '语音类声音置信度达到该阈值且达到最小时长才记录，推荐 45%–60%。' },
  {
    key: 'apnea',
    label: '暂停',
    desc: '连续无声超过该时长、随后由鼾声或呼吸声收口时判为一次疑似暂停（10–30 秒，推荐 10–15 秒）。仅供参考，不构成医疗诊断。',
  },
];

function cachePath(name: string): string {
  const dir = FileSystem.cacheDirectory || '';
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// 录音文件存放在缓存目录，可能被清理逻辑或系统删除；播放前用于校验文件是否仍存在。
async function recordingExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return !!info.exists && !info.isDirectory;
  } catch {
    return false;
  }
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
    const apkAsset = (data.assets || []).find(
      (a: { name?: string; browser_download_url?: string }) => a.name?.endsWith('.apk')
    );
    if (!apkAsset?.browser_download_url) return null;
    // 只接受本仓库 Releases 下发的地址，防止更新接口被投毒后引导用户下载第三方 APK
    if (!apkAsset.browser_download_url.startsWith(EXPECTED_DOWNLOAD_PREFIX)) {
      console.warn('更新包地址校验失败：非本仓库 Releases 资源', apkAsset.browser_download_url);
      return null;
    }
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
  // 是否保存整夜 WAV 录音（P1 存储）：关闭后只识别不写盘，一晚可省约 1GB
  const [saveRecording, setSaveRecording] = useState(true);
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

  // 首次启动先展示隐私与用途说明，用户同意后再请求麦克风权限
  // （null = 启动加载中，false = 尚未同意，true = 已同意）
  const [privacyAccepted, setPrivacyAccepted] = useState<boolean | null>(null);
  const [themePref, setThemePref] = useState<ThemePreference>('system');
  const [showAdvanced, setShowAdvanced] = useState(false); // 首页「高级信息」折叠
  const [thresholdTab, setThresholdTab] = useState<ThresholdTab>('snore'); // 设置页阈值分段切换

  const colorScheme = useColorScheme();
  const T = resolveTheme(colorScheme, themePref);
  const styles = makeStyles(T);

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
  const currentTotalFramesRef = useRef<number>(0);
  /** 呼吸暂停状态机：带上限与呼吸声上下文，避免“安静一整晚”被误判为一次长暂停 */
  const apneaTrackerRef = useRef<ApneaTracker>(
    new ApneaTracker({ minSilenceMs: apneaMinSilenceMs(DEFAULT_APNEA_CONFIDENCE) })
  );
  /** 各类事件已结束的累计毫秒数：O(1) 更新，替代原先每帧 4 次全量 filter */
  const totalsRef = useRef({ snore: 0, grind: 0, talk: 0, apnea: 0 });
  const tickCountRef = useRef(0); // 监测循环计数，用于周期性落盘快照
  const eventsTruncatedRef = useRef<boolean>(false);
  const lastWindowIdRef = useRef<number>(-1); // YAMNet 推理窗口序号，避免同一结果被重复计帧
  const currentMaxSnoreConfRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const lastMeteringRef = useRef<number>(-100); // expo-av 回调方式的最新 metering 值
  const lastLoudTimeRef = useRef<number>(0); // 最后一次响亮的时间
  const maxVolumeDbRef = useRef<number>(-100); // 本次监测最大音量
  const downloadResumableRef = useRef<FileSystem.DownloadResumable | null>(null);

  // 启动流程：加载设置 → 清理过期录音 → 加载历史 → 恢复中断会话 → 静默检查权限 → 检查更新
  // 注意：这里只「检查」麦克风权限而不「请求」，权限弹窗由用户同意隐私说明并点击开始时触发。
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
          if (typeof settings.apneaThreshold === 'number') {
            const apnea = Math.max(0.1, Math.min(0.9, settings.apneaThreshold));
            setApneaThreshold(apnea);
            apneaTrackerRef.current.setMinSilenceMs(apneaMinSilenceMs(apnea));
          }
          if (typeof settings.saveRecording === 'boolean' && mounted) {
            setSaveRecording(settings.saveRecording);
          }
        }
      } catch (e) {
        console.warn('加载设置失败', e);
      }

      try {
        const [consentRaw, prefRaw] = await Promise.all([
          AsyncStorage.getItem(CONSENT_KEY),
          AsyncStorage.getItem(THEME_PREF_KEY),
        ]);
        if (!mounted) return;
        setPrivacyAccepted(consentRaw === 'true');
        if (prefRaw === 'light' || prefRaw === 'dark' || prefRaw === 'system') {
          setThemePref(prefRaw);
        }
      } catch (e) {
        console.warn('读取偏好设置失败', e);
        if (mounted) setPrivacyAccepted(false);
      }

      // 先清理过期录音再加载会话：加载时会对账录音文件是否存在，
      // 顺序保证对账看到的是清理后的真实文件系统状态。
      await cleanOldRecordings();
      await loadSessions();
      const permitted = await hasMicPermission();
      // 必须在 loadSessions 之后：恢复的记录要叠加在历史之上
      await restoreActiveSession();
      if (mounted) {
        setHasPermission(permitted);
        setIsReady(true);
        checkUpdate(false);
      }
    })();
    return () => {
      mounted = false;
    };
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

  const openBatterySettings = async () => {
    if (Platform.OS !== 'android') return;
    try {
      await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    } catch {
      Linking.openSettings();
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
    // 记录失败阶段：下载/校验失败与安装权限失败要给出不同提示
    let stage: 'download' | 'verify' | 'install' = 'download';

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
      stage = 'verify';

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
      stage = 'install';
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
        if (stage !== 'install') {
          // 下载或校验阶段失败：与安装权限无关，展示真实原因
          Alert.alert(
            '更新失败',
            `原因：${e instanceof Error ? e.message : String(e)}`,
            [
              { text: '取消', style: 'cancel' },
              { text: '重试', onPress: () => downloadAndInstallApk(url, interactive) },
            ]
          );
          return;
        }
        Alert.alert(
          '安装权限未开启',
          '系统需要“允许安装未知应用”权限才能自动安装更新。请前往设置开启后，再次点击“立即更新”。',
          [
            { text: '取消', style: 'cancel' },
            { text: '重试', onPress: () => downloadAndInstallApk(url, interactive) },
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
          eventsTruncated: s.eventsTruncated ?? false,
          events: (s.events || []).map((e) => ({
            ...e,
            type: e.type || 'snore',
            intensity: e.intensity,
          })),
        }));
        // 校验录音文件是否仍存在：缓存目录可能被系统或清理逻辑删除，
        // 失效的 recordingUri 在此清空，避免详情页显示无法播放的按钮。
        const reconciled = await Promise.all(
          normalized.map(async (s) => {
            if (!s.recordingUri) return s;
            if (await recordingExists(s.recordingUri)) return s;
            return { ...s, recordingUri: undefined };
          })
        );
        reconciled.sort((a, b) => b.startTime - a.startTime);
        setSessions(reconciled);
      }
    } catch (e) {
      console.warn('加载历史失败', e);
    }
  };

  /**
   * 恢复上次未正常结束的监测会话（P0 修复）。
   *
   * 旧版只在「停止监测」时才把事件写入存储，应用被杀 / 手机重启 / 系统回收都会
   * 让整晚数据凭空消失。现在监测期间每约 30 秒写一次增量快照，启动时发现快照
   * 即恢复为一条历史记录，用户不再需要为“白录一晚”买单。
   */
  const restoreActiveSession = async () => {
    try {
      const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
      if (!raw) return;
      await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
      const snap = JSON.parse(raw) as {
        startTime?: number;
        lastElapsedMs?: number;
        events?: SoundEvent[];
        eventsTruncated?: boolean;
        recordingUri?: string;
      };
      const startTime = typeof snap.startTime === 'number' ? snap.startTime : 0;
      const lastElapsedMs = typeof snap.lastElapsedMs === 'number' ? snap.lastElapsedMs : 0;
      const events: SoundEvent[] = Array.isArray(snap.events) ? snap.events : [];
      // 不足 1 分钟的碎片不值得占用一条历史记录
      if (!startTime || lastElapsedMs < 60_000) return;

      // 中断时原生侧没有机会回写 WAV 头，文件不可播放，直接删除避免占空间
      if (snap.recordingUri) {
        FileSystem.deleteAsync(snap.recordingUri, { idempotent: true }).catch(() => {});
      }

      const session = summarizeSession({
        startTime,
        endTime: startTime + lastElapsedMs,
        events,
        eventsTruncated: snap.eventsTruncated,
        interrupted: true,
      });
      setSessions((prev) => [session, ...prev]);
      Alert.alert(
        '已恢复中断的监测',
        `检测到上次监测未正常结束，已恢复 ${events.length} 条事件（时长 ${formatDuration(
          Math.floor(lastElapsedMs / 1000)
        )}）。中断期间的录音无法回放。`
      );
    } catch (e) {
      console.warn('恢复进行中的会话失败', e);
    }
  };

  /** 写入进行中会话的增量快照（约 30 秒一次） */
  const writeActiveSnapshot = async (lastElapsedMs: number) => {
    try {
      await AsyncStorage.setItem(
        ACTIVE_SESSION_KEY,
        JSON.stringify({
          startTime: startTimeRef.current,
          lastElapsedMs,
          events: eventsRef.current,
          eventsTruncated: eventsTruncatedRef.current,
          recordingUri: recordingUriRef.current || undefined,
        })
      );
    } catch (e) {
      console.warn('写入监测快照失败', e);
    }
  };

  const clearActiveSnapshot = async () => {
    try {
      await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch (e) {
      console.warn('清理监测快照失败', e);
    }
  };

  const saveSettings = async (
    nextSnore: number,
    nextGrind: number,
    nextTalk: number,
    nextApnea: number
  ) => {
    // 阈值同步给原生判定状态机，保证设置页与实际判定一致
    apneaTrackerRef.current.setMinSilenceMs(apneaMinSilenceMs(nextApnea));
    try {
      await AsyncStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          snoreThreshold: nextSnore,
          grindThreshold: nextGrind,
          talkThreshold: nextTalk,
          apneaThreshold: nextApnea,
          // 一并回写，避免覆盖掉用户已保存的录音偏好
          saveRecording,
        })
      );
    } catch (e) {
      console.warn('保存设置失败', e);
    }
  };

  /** 切换「保存整夜录音」偏好：合并写入设置，避免覆盖阈值字段 */
  const applySaveRecordingPref = async (value: boolean) => {
    setSaveRecording(value);    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      const settings = raw ? JSON.parse(raw) : {};
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, saveRecording: value }));
    } catch (e) {
      console.warn('保存录音偏好失败', e);
    }
  };

  /** 静默检查麦克风权限，不弹窗（启动时用） */
  const hasMicPermission = async (): Promise<boolean> => {
    try {
      if (Platform.OS === 'android') {
        const perm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
        if (!perm) return false;
        return await PermissionsAndroid.check(perm);
      }
      const { status } = await Audio.getPermissionsAsync();
      return status === 'granted';
    } catch (e) {
      console.warn('检查麦克风权限失败', e);
      return false;
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
          message: '睡眠监测需要访问麦克风以录制鼾声、磨牙等声音。录音与分析全部在本机完成，不会上传。',
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

  /**
   * Android 13+ 需要运行时申请通知权限，否则前台服务的「监测中」通知不会显示，
   * 用户看不到应用仍在录音，既缺安全感也会误以为已经停止。
   */
  const requestNotificationPermission = async () => {
    if (Platform.OS !== 'android') return;
    if (typeof Platform.Version === 'number' && Platform.Version < 33) return;
    try {
      const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
      if (!perm) return;
      const status = await PermissionsAndroid.check(perm);
      if (status) return;
      await PermissionsAndroid.request(perm, {
        title: '显示「监测中」通知',
        message: '用于在息屏/后台时显示监测状态，避免系统静默停止录音。',
        buttonNegative: '暂不',
        buttonPositive: '允许',
      });
    } catch (e) {
      console.warn('申请通知权限失败', e);
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

    // 存储空间预检：整晚 WAV 录音约 115MB/小时；不保存录音时不占这份空间，无需预检
    if (saveRecording) {
      try {
        const freeBytes = await FileSystem.getFreeDiskStorageAsync();
        if (freeBytes < MIN_FREE_STORAGE_BYTES) {
          Alert.alert('存储空间不足', '剩余空间不足 1.5GB，可能无法保存整晚录音，请先在设置页清理缓存。');
        }
      } catch {
        // 预检失败不影响启动
      }
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
            // 呼吸暂停判定由 JS 根据连续无声时长计算，原生模块只需打鼾/磨牙/梦话阈值
            await AudioMeter.setThresholds(snoreThreshold, grindThreshold, talkThreshold);
          } catch (thresholdErr) {
            console.warn('同步阈值到原生模块失败', thresholdErr);
          }
          // 原生模块：用 AudioRecord 录音 + YAMNet 模型实时推理
          const recordingUri = await AudioMeter.startRecording(saveRecording);
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
      currentTotalFramesRef.current = 0;
      currentMaxSnoreConfRef.current = 0;
      lastLoudTimeRef.current = 0;
      maxVolumeDbRef.current = -100;
      apneaTrackerRef.current.reset();
      apneaTrackerRef.current.setMinSilenceMs(apneaMinSilenceMs(apneaThreshold));
      totalsRef.current = { snore: 0, grind: 0, talk: 0, apnea: 0 };
      tickCountRef.current = 0;
      eventsTruncatedRef.current = false;
      lastWindowIdRef.current = -1;
      setMaxVolumeDb(-100);
      // 立即写一份快照，即使刚启动就崩溃也有据可查
      writeActiveSnapshot(0);
      // Android 13+：申请通知权限，让「监测中」通知可见
      requestNotificationPermission();

      // 用递归 setTimeout 替代 setInterval，避免 async monitorLoop 调用重叠
      const runLoop = async () => {
        await monitorLoop();
        tickCountRef.current += 1;
        // 每约 30 秒落盘一次进行中会话的快照（P0：应用被杀不丢整晚数据）
        if (tickCountRef.current % ACTIVE_SNAPSHOT_TICKS === 0) {
          writeActiveSnapshot(Date.now() - startTimeRef.current);
        }
        if (monitorTimerRef.current !== null) {
          monitorTimerRef.current = setTimeout(runLoop, CHUNK_MS);
        }
      };
      monitorTimerRef.current = setTimeout(runLoop, CHUNK_MS);
      setIsMonitoring(true);
    } catch (e) {
      console.error('开始录音失败', e);
      Alert.alert('启动失败', String(e));
      // 启动失败时必须清理底层引用，否则入口_guard_会阻止再次启动
      useNativeMeterRef.current = false;
      recordingRef.current = null;
      recordingUriRef.current = '';
      setIsMonitoring(false);
      setIsFallbackMode(false);
      deactivateKeepAwake('monitor').catch(() => {});
    } finally {
      setIsBusy(false);
    }
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
        const windowId = typeof result.windowId === 'number' ? result.windowId : -1;
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

        // YAMNet 推理窗口 0.975s、轮询 300ms：同一推理结果只计一帧，避免帧统计失真。
        if (windowId === lastWindowIdRef.current) {
          return;
        }
        lastWindowIdRef.current = windowId;

        // 帧级分类：打鼾/梦话仍要求是该帧 top 类别；
        // 磨牙放宽为只要置信度超过阈值且高于其它两类事件即可（不必胜过噪音），
        // 因为磨牙通常是短暂的高频摩擦音，很少成为 YAMNet 聚合后的绝对 top。
        const isSnoreFrame = tClass === 'snoring' && sConf >= snoreThreshold;
        const isGrindFrame = gConf >= grindThreshold && gConf >= sConf && gConf >= tConf;
        const isTalkFrame = tClass === 'talking' && tConf >= talkThreshold;
        const isLoud = isSnoreFrame || isGrindFrame || isTalkFrame;
        // 异常呼吸音（喘息/喘鸣/喷气）不再单独计为事件，但可用来确认一次暂停的结束。
        const isApneaSound = aConf >= APNEA_SOUND_CONF;

        if (isSnoreFrame) {
          setSnoreIntensity(classifyIntensity(sConf));
        } else if (!isLoud) {
          setSnoreIntensity(null);
        }
        setIsSnoringNow(isLoud);
        // loud = 任意事件帧，用于锚定静音起点；
        // breath = 鼾声帧或异常呼吸音，用于「收口」一次疑似暂停（普通噪声不收口）。
        trackSilence(
          { loud: isLoud || isApneaSound, breath: isSnoreFrame || isApneaSound },
          sessionElapsed
        );
        detectEvent(isSnoreFrame, isGrindFrame, isTalkFrame, sessionElapsed, sConf);
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
    // 兼容模式没有模型可用：响声即视为呼吸声，60 秒时长上限仍能兜住误判
    trackSilence({ loud: isLoud, breath: isLoud }, sessionElapsed);
    detectEvent(isLoud, false, false, sessionElapsed, 0);
  };

  // 呼吸暂停检测（P0 修复）：判定逻辑收敛到 ApneaTracker，它带三道约束——
  //   1) 静音时长上限 60s：超长安静（用户离床、安静房间、闹钟响起）不再生成横跨整晚的假事件；
  //   2) 结束声音必须是呼吸类（鼾声/喘息），普通噪声、梦话、磨牙不收口；
  //   3) 静音开始前 5 分钟内必须出现过呼吸类声音，避免给不打鼾的用户凭空记暂停。
  // 粗略筛查，不构成医疗诊断。
  const trackSilence = (signal: { loud: boolean; breath: boolean }, sessionElapsed: number) => {
    const evt: ApneaEvent | null = apneaTrackerRef.current.onFrame(sessionElapsed, signal);
    if (!evt) return;
    if (eventsRef.current.length >= MAX_EVENTS_PER_SESSION) {
      eventsTruncatedRef.current = true;
      return;
    }
    const stored: SoundEvent = {
      start: evt.start,
      end: evt.end,
      duration: evt.duration,
      type: 'apnea',
      capped: evt.capped,
    };
    eventsRef.current.push(stored);
    accumulate(stored);
    setApneaCount((c) => c + 1);
  };

  /** 事件落定时累计时长（O(1)），并同步 UI 上的分类计时 */
  const accumulate = (evt: SoundEvent) => {
    totalsRef.current[evt.type] += evt.duration;
    const t = totalsRef.current;
    setSnoreSeconds(Math.floor(t.snore / 1000));
    setGrindSeconds(Math.floor(t.grind / 1000));
    setTalkSeconds(Math.floor(t.talk / 1000));
    setApneaSeconds(Math.floor(t.apnea / 1000));
  };

  // 事件检测：按帧标记为鼾声/磨牙/梦话，事件结束时根据帧比例与持续时间分类。
  // （呼吸暂停改由 trackSilence 基于连续无声区间检测，不再走声音事件帧。）
  const detectEvent = (
    isSnoreFrame: boolean,
    isGrindFrame: boolean,
    isTalkFrame: boolean,
    sessionElapsed: number,
    snoreConf: number
  ) => {
    const isLoud = isSnoreFrame || isGrindFrame || isTalkFrame;

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
      }
    } else {
      // 静音时，只有超过宽限期才结束当前事件
      const silenceDuration = sessionElapsed - lastLoudTimeRef.current;
      if (silenceDuration >= GRACE_MS) {
        finalizeCurrentEvent();
      }
    }

    // 每帧 O(1) 更新：已结束事件时长走 totalsRef，进行中事件单独加进来，
    // 避免旧实现每 300ms 对最多上千条事件做 4 次全量 filter。
    const t = totalsRef.current;
    const finishedNoiseMs = t.snore + t.grind + t.talk;
    const ongoing = currentEventRef.current ? currentEventRef.current.duration : 0;
    setTotalNoiseSeconds(Math.floor((finishedNoiseMs + ongoing) / 1000));
    setSnoreSeconds(Math.floor(t.snore / 1000));
    setGrindSeconds(Math.floor(t.grind / 1000));
    setTalkSeconds(Math.floor(t.talk / 1000));
    setApneaSeconds(Math.floor(t.apnea / 1000));
  };

  const finalizeCurrentEvent = () => {
    const evt = currentEventRef.current;
    if (!evt) return;

    const duration = evt.end - evt.start;
    const classified = classifyFinalEvent(
      duration,
      {
        snore: currentSnoreFramesRef.current,
        grind: currentGrindFramesRef.current,
        talk: currentTalkFramesRef.current,
        total: currentTotalFramesRef.current,
      },
      currentMaxSnoreConfRef.current
    );

    if (classified) {
      if (eventsRef.current.length < MAX_EVENTS_PER_SESSION) {
        const stored: SoundEvent = {
          ...evt,
          type: classified.type,
          intensity: classified.intensity,
        };
        eventsRef.current.push(stored);
        accumulate(stored);
        if (classified.type === 'snore') setSnoreCount((c) => c + 1);
        else if (classified.type === 'grind') setGrindCount((c) => c + 1);
        else if (classified.type === 'talk') setTalkCount((c) => c + 1);
      } else {
        eventsTruncatedRef.current = true;
      }
    }

    currentEventRef.current = null;
    currentSnoreFramesRef.current = 0;
    currentGrindFramesRef.current = 0;
    currentTalkFramesRef.current = 0;
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
        uri = (await AudioMeter.stopRecording()) || undefined;
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

      // 收尾当前事件
      finalizeCurrentEvent();

      // 统计口径集中在 summarizeSession（纯函数 + 单元测试），
      // 正常停止与崩溃恢复两条路径共用，避免口径漂移。
      const session = summarizeSession({
        startTime: startTimeRef.current,
        endTime,
        events: eventsRef.current,
        recordingUri: uri,
        eventsTruncated: eventsTruncatedRef.current,
      });

      setSessions((prev) => [session, ...prev]);
      // 会话已落库，删掉进行中的快照，避免下次启动重复恢复
      clearActiveSnapshot();
    } catch (e) {
      console.error('停止监测失败', e);
      Alert.alert('保存失败', String(e));
    }

    useNativeMeterRef.current = false;
    recordingUriRef.current = '';
    totalsRef.current = { snore: 0, grind: 0, talk: 0, apnea: 0 };
    tickCountRef.current = 0;
    apneaTrackerRef.current.reset();
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
      // 录音存放在缓存目录，可能已被清理逻辑或系统删除。播放前先校验文件存在性，
      // 避免直接交给 ExoPlayer 抛出 FileNotFoundException。
      if (!(await recordingExists(uri))) {
        // 清掉这条会话里失效的 recordingUri，UI 不再显示播放按钮。
        setSessions((prev) =>
          prev.map((s) => (s.recordingUri === uri ? { ...s, recordingUri: undefined } : s))
        );
        if (selectedSession?.recordingUri === uri) {
          setSelectedSession((prev) => (prev ? { ...prev, recordingUri: undefined } : prev));
        }
        Alert.alert(
          '录音无法播放',
          '该录音文件已被清理（录音保留 3 天，或被系统/手动清理缓存）。事件记录仍可查看，但无法回放音频。',
          [{ text: '知道了' }]
        );
        return;
      }
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
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_PERSISTED_SESSIONS))).catch((e) => {
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

  /** 隐私同意 / 主题偏好 / 首屏所需处理器（须在早返回之前定义） */
  const acceptPrivacy = () => {
    setPrivacyAccepted(true);
    AsyncStorage.setItem(CONSENT_KEY, 'true').catch((e) => console.warn('保存隐私同意状态失败', e));
  };

  const openPrivacyPolicy = () => {
    Alert.alert('隐私政策', PRIVACY_SUMMARY, [
      { text: '关闭', style: 'cancel' },
      {
        text: '在线查看完整版',
        onPress: () => Linking.openURL(PRIVACY_POLICY_URL).catch(() => undefined),
      },
    ]);
  };

  const applyThemePref = (pref: ThemePreference) => {
    setThemePref(pref);
    AsyncStorage.setItem(THEME_PREF_KEY, pref).catch((e) => console.warn('保存主题偏好失败', e));
  };

  const isDarkTheme =
    themePref === 'dark' || (themePref === 'system' && colorScheme === 'dark');

  /** 首次启动隐私同意页：同意前不进入主界面，也绝不请求任何系统权限 */
  const renderConsent = () => (
    <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
      <View style={styles.heroCard}>
        <View style={styles.heroAccentBar} />
        <View style={styles.heroHeader}>
          <View style={styles.appIconCircle}>
            <Ionicons name="moon" size={26} color={T.onAccent} />
          </View>
          <View style={styles.heroTitleBlock}>
            <Text style={styles.title}>欢迎使用睡眠监测</Text>
            <Text style={styles.subtitle}>v{CURRENT_VERSION} · 开始前请先了解隐私说明</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>你的声音，只留在你的手机里</Text>
        {PRIVACY_SUMMARY.split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => (
            <Text key={line} style={styles.consentBullet}>
              {line}
            </Text>
          ))}
        <Text style={styles.disclaimerText}>
          继续即表示你已阅读并理解上述说明。麦克风权限会在你首次点击「开始睡眠监测」时才申请。
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.mainButton, styles.startButton]}
        onPress={acceptPrivacy}
        activeOpacity={0.85}
      >
        <Ionicons name="checkmark-circle" size={20} color={T.onAccent} style={{ marginRight: 8 }} />
        <Text style={styles.mainButtonText}>同意并继续</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={openPrivacyPolicy} activeOpacity={0.7}>
        <Text style={styles.consentLink}>查看隐私政策</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  if (!isReady) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={T.primary} />
        <Text style={styles.loadingText}>正在初始化…</Text>
      </SafeAreaView>
    );
  }

  // 首次启动：未同意隐私说明前只渲染同意页（P0 合规：先告知、后授权）
  if (privacyAccepted !== true) {
    return renderConsent();
  }

  // UI 渲染
  const renderHome = () => (
    <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
      {/* 顶部标题区 */}
      <View style={styles.heroCard}>
        <View style={styles.heroAccentBar} />
        <View style={styles.heroHeader}>
          <View style={styles.appIconCircle}>
            <Ionicons name="moon" size={26} color={T.onAccent} />
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
              <Ionicons name="arrow-up-circle" size={14} color={T.onAccent} />
              <Text style={styles.updateBadgeText}>新版</Text>
            </TouchableOpacity>
          )}
        </View>

        {hasPermission === false && (
          <View style={styles.warningBox}>
            <Ionicons name="warning-outline" size={20} color={T.warningFg} />
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
            <Ionicons name="information-circle-outline" size={20} color={T.infoFg} />
            <Text style={styles.infoText}>
              兼容模式：仅检测音量，不区分鼾声/磨牙等事件。
            </Text>
          </View>
        )}

        {/* 计时器 */}
        <View style={styles.timerBox}>
          <View style={styles.timerPill}>
            <View style={[styles.timerDot, { backgroundColor: isMonitoring ? T.danger : T.textTertiary }]} />
            <Text style={styles.timerLabel}>{isMonitoring ? '监测中' : '待机'}</Text>
          </View>
          <Text style={styles.timerValue}>{formatDuration(elapsedSeconds)}</Text>
        </View>

        {/* 四类统计卡片 */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${T.snore}18` }]}>
              <Ionicons name="volume-high" size={20} color={T.snore} />
            </View>
            <Text style={styles.statValue}>{snoreCount}</Text>
            <Text style={styles.statLabel}>打鼾</Text>
            <Text style={styles.statSub}>{formatDuration(snoreSeconds)}</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${T.grind}18` }]}>
              <Ionicons name="git-branch" size={20} color={T.grind} />
            </View>
            <Text style={styles.statValue}>{grindCount}</Text>
            <Text style={styles.statLabel}>磨牙</Text>
            <Text style={styles.statSub}>{formatDuration(grindSeconds)}</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${T.talk}18` }]}>
              <Ionicons name="chatbubble" size={20} color={T.talk} />
            </View>
            <Text style={styles.statValue}>{talkCount}</Text>
            <Text style={styles.statLabel}>梦话</Text>
            <Text style={styles.statSub}>{formatDuration(talkSeconds)}</Text>
          </View>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: `${T.apnea}18` }]}>
              <Ionicons name="pulse" size={20} color={T.apnea} />
            </View>
            <Text style={styles.statValue}>{apneaCount}</Text>
            <Text style={styles.statLabel}>呼吸暂停</Text>
            <Text style={styles.statSub}>{formatDuration(apneaSeconds)}</Text>
          </View>
        </View>

        {/* 实时音量区域 */}
        <View style={styles.volumeBox}>
          <View style={styles.volumeHeader}>
            <Text style={styles.volumeLabel}>实时音量</Text>
            <Text style={styles.volumeHeaderValue}>{volumeDb.toFixed(1)} dB</Text>
          </View>
          <View style={styles.volumeBarBg}>
            <View
              style={[
                styles.volumeBarFill,
                {
                  width: `${Math.min(100, Math.max(0, (volumeDb + 80) / 80 * 100))}%`,
                  backgroundColor: isSnoringNow ? T.danger : T.primary,
                },
              ]}
            />
          </View>
          <View style={styles.volumeRow}>
            <Text style={[styles.volumeState, { color: isSnoringNow ? T.danger : T.textSecondary }]}>
              {isSnoringNow ? '● 检测到声音' : '○ 环境安静'}
            </Text>
            <Text style={styles.volumeState}>
              峰值 {maxVolumeDb > -100 ? maxVolumeDb.toFixed(1) + ' dB' : '--'} · 声音 {formatDuration(totalNoiseSeconds)}
            </Text>
          </View>

          {/* 高级信息折叠开关：置信度/强度/峰值音量等细节默认收起，避免首页信息过载 */}
          <TouchableOpacity
            style={styles.advancedToggle}
            onPress={() => setShowAdvanced((v) => !v)}
            activeOpacity={0.75}
          >
            <Text style={styles.advancedToggleText}>高级信息</Text>
            <Ionicons
              name={showAdvanced ? 'chevron-up' : 'chevron-down'}
              size={13}
              color={T.textSecondary}
            />
          </TouchableOpacity>

          {showAdvanced && (
            <>
          {/* AI 模型置信度 - 分卡片展示 */}
          {!isFallbackMode && (
            <View style={styles.confidenceGrid}>
              <View style={[styles.confidenceChip, { backgroundColor: `${T.snore}12` }]}>
                <Text style={[styles.confidenceLabel, { color: T.snore }]}>打鼾</Text>
                <Text style={[styles.confidenceValue, { color: T.snore }]}>{(snoreConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${T.grind}12` }]}>
                <Text style={[styles.confidenceLabel, { color: T.grind }]}>磨牙</Text>
                <Text style={[styles.confidenceValue, { color: T.grind }]}>{(grindConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${T.talk}12` }]}>
                <Text style={[styles.confidenceLabel, { color: T.talk }]}>梦话</Text>
                <Text style={[styles.confidenceValue, { color: T.talk }]}>{(talkConfidence * 100).toFixed(0)}%</Text>
              </View>
              <View style={[styles.confidenceChip, { backgroundColor: `${T.apnea}12` }]}>
                <Text style={[styles.confidenceLabel, { color: T.apnea }]}>异常呼吸音</Text>
                <Text style={[styles.confidenceValue, { color: T.apnea }]}>{(apneaConfidence * 100).toFixed(0)}%</Text>
              </View>
            </View>
          )}

          {/* 当前识别类别 */}
          {!isFallbackMode && (
            <View style={styles.topClassRow}>
              <Ionicons name="analytics" size={14} color={T.textTertiary} />
              <Text style={styles.topClassText}>
                当前识别：{getClassLabel(topClass)} {(topConfidence * 100).toFixed(0)}%
              </Text>
            </View>
          )}

          {snoreIntensity && (
            <View style={[styles.intensityBadge, { backgroundColor: getIntensityColor(snoreIntensity, T) + '20' }]}>
              <Ionicons name="alert-circle" size={14} color={getIntensityColor(snoreIntensity, T)} />
              <Text style={[styles.intensityText, { color: getIntensityColor(snoreIntensity, T) }]}>
                鼾声强度：{getIntensityLabel(snoreIntensity)}
              </Text>
            </View>
          )}
            </>
          )}
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
            <ActivityIndicator size="small" color={T.onAccent} />
          ) : (
            <>
              <Ionicons
                name={isMonitoring ? 'stop-circle' : 'play-circle'}
                size={22}
                color={T.onAccent}
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
            <Ionicons name="battery-charging" size={13} color={T.textTertiary} />
            <Text style={styles.tipText}>监测中 · 已启用后台录音，可息屏运行，建议连接充电器</Text>
          </View>
        )}
      </View>

      {/* 底部导航 */}
      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('history')} activeOpacity={0.85}>
          <View style={[styles.navIconCircle, { backgroundColor: `${T.primary}15` }]}>
            <Ionicons name="time" size={22} color={T.primary} />
          </View>
          <Text style={styles.navButtonText}>历史记录</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => setScreen('settings')} activeOpacity={0.85}>
          <View style={[styles.navIconCircle, { backgroundColor: `${T.primary}15` }]}>
            <Ionicons name="settings" size={22} color={T.primary} />
          </View>
          <Text style={styles.navButtonText}>设置</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderHistory = () => (
    <View style={styles.flex}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={T.primary} />
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
              <Ionicons name="bed-outline" size={48} color={T.primary} />
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
                  <Ionicons name="time-outline" size={14} color={T.textTertiary} />
                  <Text style={styles.historyMeta}>睡眠 {formatDuration(item.durationSeconds)}</Text>
                </View>
                <View style={styles.historyCountRow}>
                  <View style={[styles.historyCount, { backgroundColor: `${T.snore}15` }]}>
                    <Ionicons name="volume-high-outline" size={14} color={T.snore} />
                    <Text style={[styles.historyCountText, { color: T.snore }]}>{item.snoreCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${T.grind}15` }]}>
                    <Ionicons name="git-branch-outline" size={14} color={T.grind} />
                    <Text style={[styles.historyCountText, { color: T.grind }]}>{item.grindCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${T.talk}15` }]}>
                    <Ionicons name="chatbubble-outline" size={14} color={T.talk} />
                    <Text style={[styles.historyCountText, { color: T.talk }]}>{item.talkCount}</Text>
                  </View>
                  <View style={[styles.historyCount, { backgroundColor: `${T.apnea}15` }]}>
                    <Ionicons name="pulse-outline" size={14} color={T.apnea} />
                    <Text style={[styles.historyCountText, { color: T.apnea }]}>{item.apneaCount}</Text>
                  </View>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <View style={[styles.qualityBadge, { backgroundColor: getQualityColor(item.qualityScore, T) }]}>
                  <Text style={styles.qualityText}>{item.qualityScore}分</Text>
                </View>
                <View style={[styles.apneaRiskBadge, { backgroundColor: getApneaRiskColor(item.apneaRisk || 'low', T), marginTop: 6 }]}>
                  <Text style={styles.apneaRiskText}>{getApneaRiskLabel(item.apneaRisk || 'low')}</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={T.textTertiary} style={{ marginLeft: 8 }} />
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
            <Ionicons name="chevron-back" size={26} color={T.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>记录详情</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.card}>
          <View style={styles.detailHeader}>
            <View style={[styles.detailIconCircle, { backgroundColor: `${T.primary}15` }]}>
              <Ionicons name="moon-outline" size={24} color={T.primary} />
            </View>
            <View>
              <Text style={styles.detailTime}>{formatTime(selectedSession.startTime)}</Text>
              <Text style={styles.detailSubTime}>睡眠时长 {formatDuration(selectedSession.durationSeconds)}</Text>
            </View>
          </View>

          <View style={styles.detailStatsGrid}>
            <View style={styles.detailStatCard}>
              <Ionicons name="volume-high-outline" size={20} color={T.snore} />
              <Text style={styles.detailStatValue}>{selectedSession.snoreCount}</Text>
              <Text style={styles.detailStatLabel}>打鼾</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="git-branch-outline" size={20} color={T.grind} />
              <Text style={styles.detailStatValue}>{selectedSession.grindCount}</Text>
              <Text style={styles.detailStatLabel}>磨牙</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="chatbubble-outline" size={20} color={T.talk} />
              <Text style={styles.detailStatValue}>{selectedSession.talkCount}</Text>
              <Text style={styles.detailStatLabel}>梦话</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="pulse-outline" size={20} color={T.apnea} />
              <Text style={styles.detailStatValue}>{selectedSession.apneaCount}</Text>
              <Text style={styles.detailStatLabel}>呼吸暂停</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="volume-medium-outline" size={20} color={T.warning} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalSnoreSeconds)}</Text>
              <Text style={styles.detailStatLabel}>鼾声时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="git-branch-outline" size={20} color={T.grind} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalGrindSeconds)}</Text>
              <Text style={styles.detailStatLabel}>磨牙时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="chatbubble-outline" size={20} color={T.talk} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalTalkSeconds)}</Text>
              <Text style={styles.detailStatLabel}>梦话时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="pulse-outline" size={20} color={T.apnea} />
              <Text style={styles.detailStatValue}>{formatDuration(selectedSession.totalApneaSeconds)}</Text>
              <Text style={styles.detailStatLabel}>呼吸暂停时长</Text>
            </View>
            <View style={styles.detailStatCard}>
              <Ionicons name="list-outline" size={20} color={T.textSecondary} />
              <Text style={styles.detailStatValue}>{selectedSession.events.length}</Text>
              <Text style={styles.detailStatLabel}>事件总数</Text>
            </View>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getQualityColor(selectedSession.qualityScore, T), marginBottom: 10 }]}>
            <Text style={styles.qualityTextLarge}>睡眠质量 {selectedSession.qualityScore} 分</Text>
          </View>

          <View style={[styles.qualityBadgeLarge, { backgroundColor: getApneaRiskColor(selectedSession.apneaRisk || 'low', T) }]}>
            <Text style={styles.qualityTextLarge}>呼吸暂停风险 {getApneaRiskLabel(selectedSession.apneaRisk || 'low')}</Text>
          </View>

          <Text style={styles.disclaimerText}>
            呼吸暂停筛查基于连续无声时长估算，仅供参考，不构成医疗诊断；如有疑虑请就医进行专业睡眠监测（多导睡眠图）。
          </Text>

          {selectedSession.intensityBreakdown && selectedSession.snoreCount > 0 && (
            <View style={{ marginBottom: 24 }}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="stats-chart-outline" size={16} color={T.text} /> 鼾声强度分布
              </Text>
              <View style={styles.intensityRow}>
                <View style={[styles.intensityBlock, { backgroundColor: `${T.success}20` }]}>
                  <Text style={[styles.detailStatValue, { color: T.success }]}>{selectedSession.intensityBreakdown.mild}</Text>
                  <Text style={styles.detailStatLabel}>轻度</Text>
                </View>
                <View style={[styles.intensityBlock, { backgroundColor: `${T.warning}20` }]}>
                  <Text style={[styles.detailStatValue, { color: T.warning }]}>{selectedSession.intensityBreakdown.moderate}</Text>
                  <Text style={styles.detailStatLabel}>中度</Text>
                </View>
                <View style={[styles.intensityBlock, { backgroundColor: `${T.danger}20` }]}>
                  <Text style={[styles.detailStatValue, { color: T.danger }]}>{selectedSession.intensityBreakdown.severe}</Text>
                  <Text style={styles.detailStatLabel}>重度</Text>
                </View>
              </View>
            </View>
          )}

          {selectedSession.recordingUri ? (
            <View style={styles.recordingBox}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="mic-outline" size={16} color={T.text} /> 录音回放
              </Text>
              <TouchableOpacity
                style={[styles.mainButton, isPlaying ? styles.stopButton : styles.startButton]}
                onPress={() =>
                  isPlaying ? stopPlayback() : playRecording(selectedSession.recordingUri!)
                }
              >
                <Ionicons name={isPlaying ? 'square' : 'play'} size={18} color={T.onAccent} style={{ marginRight: 8 }} />
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
                          backgroundColor: T.primary,
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
              <Ionicons name="mic-off-outline" size={32} color={T.textTertiary} />
              <Text style={styles.noRecordingText}>暂无录音可回放</Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>
            <Ionicons name="list-outline" size={16} color={T.text} /> 异常声音事件
          </Text>
          {selectedSession.eventsTruncated && (
            <Text style={styles.disclaimerText}>当晚事件过多，仅保留前 {MAX_EVENTS_PER_SESSION} 条。</Text>
          )}
          {selectedSession.events.length === 0 ? (
            <View style={styles.emptyEventBox}>
              <View style={[styles.eventIconCircle, { backgroundColor: `${T.success}15` }]}>
                <Ionicons name="checkmark-circle-outline" size={24} color={T.success} />
              </View>
              <Text style={styles.noRecordingText}>未检测到异常声音事件</Text>
            </View>
          ) : (
            <View style={styles.timeline}>
              {selectedSession.events.slice(0, MAX_VISIBLE_EVENTS).map((evt, idx) => {
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
                      { borderLeftColor: getEventColor(evt.type, T) },
                      isCurrent ? { backgroundColor: `${T.primary}12` } : {},
                    ]}
                    onPress={() => selectedSession.recordingUri && seekToEvent(evt)}
                    disabled={!selectedSession.recordingUri}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.eventIconCircle, { backgroundColor: `${getEventColor(evt.type, T)}15` }]}>
                      <Ionicons name={iconName as any} size={18} color={getEventColor(evt.type, T)} />
                    </View>
                    <View style={styles.eventBody}>
                      <Text style={[styles.eventIndex, { color: getEventColor(evt.type, T) }]}>
                        #{idx + 1} {getEventLabel(evt.type, evt.intensity)}
                      </Text>
                      <Text style={styles.eventClock}>{formatClock(absStart)} · {(evt.duration / 1000).toFixed(1)}秒</Text>
                    </View>
                    {selectedSession.recordingUri && (
                      <Ionicons name="play-circle-outline" size={24} color={T.primary} />
                    )}
                  </TouchableOpacity>
                );
              })}
              {selectedSession.events.length > MAX_VISIBLE_EVENTS && (
                <Text style={styles.disclaimerText}>
                  共 {selectedSession.events.length} 条事件，此处仅显示前 {MAX_VISIBLE_EVENTS}
                  条；上方统计口径为完整数据。
                </Text>
              )}
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
                  onPress: async () => {
                    await deleteSession(selectedSession.id);
                    setSelectedSession(null);
                    setScreen('history');
                  },
                },
              ])
            }
          >
            <Ionicons name="trash-outline" size={18} color={T.onAccent} style={{ marginRight: 8 }} />
            <Text style={styles.mainButtonText}>删除此记录</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  };

  /** 当前阈值 Tab 的取值、颜色与展示文本（供设置页复用） */
  const activeTab = THRESHOLD_TABS.find((t) => t.key === thresholdTab) || THRESHOLD_TABS[0];
  const thresholdValues: Record<ThresholdTab, number> = {
    snore: snoreThreshold,
    grind: grindThreshold,
    talk: talkThreshold,
    apnea: apneaThreshold,
  };
  const thresholdColors: Record<ThresholdTab, string> = {
    snore: T.snore,
    grind: T.grind,
    talk: T.talk,
    apnea: T.apnea,
  };
  const activeValue = thresholdValues[thresholdTab];
  const activeColor = thresholdColors[thresholdTab];
  const activeDisplay =
    thresholdTab === 'apnea'
      ? `${(apneaMinSilenceMs(activeValue) / 1000).toFixed(0)}秒`
      : `${(activeValue * 100).toFixed(0)}%`;

  /** 按当前 Tab 调整阈值（0.1–0.9，步进 0.05）并同步持久化 */
  const adjustThreshold = (delta: number) => {
    const val = Math.min(0.9, Math.max(0.1, parseFloat((activeValue + delta).toFixed(2))));
    if (thresholdTab === 'snore') {
      setSnoreThreshold(val);
      saveSettings(val, grindThreshold, talkThreshold, apneaThreshold);
    } else if (thresholdTab === 'grind') {
      setGrindThreshold(val);
      saveSettings(snoreThreshold, val, talkThreshold, apneaThreshold);
    } else if (thresholdTab === 'talk') {
      setTalkThreshold(val);
      saveSettings(snoreThreshold, grindThreshold, val, apneaThreshold);
    } else {
      setApneaThreshold(val);
      saveSettings(snoreThreshold, grindThreshold, talkThreshold, val);
    }
  };


  const renderSettings = () => (
    <ScrollView style={styles.flex} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setScreen('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={T.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>设置</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.card}>
        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${activeColor}20` }]}>
              <Ionicons name="options-outline" size={20} color={activeColor} />
            </View>
            <Text style={styles.sectionTitle}>检测阈值</Text>
          </View>

          {/* 四类阈值集成：分段切换，只渲染当前类别的说明与滑条 */}
          <View style={styles.segmentRow}>
            {THRESHOLD_TABS.map((tab) => {
              const active = thresholdTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.segmentItem, active && styles.segmentItemActive]}
                  onPress={() => setThresholdTab(tab.key)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                      active && { color: activeColor },
                    ]}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.settingsDesc, { marginTop: 12 }]}>{activeTab.desc}</Text>
          <Text style={styles.thresholdValue}>{activeDisplay}</Text>
          <View style={styles.sliderRow}>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${activeColor}20` }]}
              onPress={() => adjustThreshold(-0.05)}
            >
              <Text style={[styles.adjustButtonText, { color: activeColor }]}>-</Text>
            </TouchableOpacity>
            <View style={styles.thresholdTrack}>
              <View
                style={[
                  styles.thresholdFill,
                  { width: `${((activeValue - 0.1) / 0.8) * 100}%`, backgroundColor: activeColor },
                ]}
              />
            </View>
            <TouchableOpacity
              style={[styles.adjustButton, { backgroundColor: `${activeColor}20` }]}
              onPress={() => adjustThreshold(0.05)}
            >
              <Text style={[styles.adjustButtonText, { color: activeColor }]}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: T.textTertiary, marginTop: 8 }]}
          onPress={() => {
            setSnoreThreshold(DEFAULT_SNORE_CONFIDENCE);
            setGrindThreshold(DEFAULT_GRIND_CONFIDENCE);
            setTalkThreshold(DEFAULT_TALK_CONFIDENCE);
            setApneaThreshold(DEFAULT_APNEA_CONFIDENCE);
            saveSettings(
              DEFAULT_SNORE_CONFIDENCE,
              DEFAULT_GRIND_CONFIDENCE,
              DEFAULT_TALK_CONFIDENCE,
              DEFAULT_APNEA_CONFIDENCE
            );
          }}
        >
          <Ionicons name="refresh-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
          <Text style={styles.actionButtonText}>恢复默认</Text>
        </TouchableOpacity>
      </View>

      {/* 通用设置：原先四张独立卡片合并为一张，分隔线分区，按钮紧凑化 */}
      <View style={[styles.card, { marginTop: 16 }]}>
        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.primary}20` }]}>
              <Ionicons name="cloud-download-outline" size={20} color={T.primary} />
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
              style={[styles.actionButton, { backgroundColor: T.primary, marginBottom: 8 }]}
              onPress={() => downloadAndInstallApk(latestRelease.downloadUrl)}
            >
              <Ionicons name="download-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
              <Text style={styles.actionButtonText}>下载最新版本 APK</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.actionButton,
              updateCheckState === 'checking' && { opacity: 0.6 },
              { backgroundColor: T.primary },
            ]}
            onPress={() => checkUpdate(true)}
            disabled={updateCheckState === 'checking'}
          >
            <Ionicons name="refresh-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
            <Text style={styles.actionButtonText}>
              {updateCheckState === 'checking' ? '检查中…' : '检查更新'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.primary}20` }]}>
              <Ionicons name="color-palette-outline" size={20} color={T.primary} />
            </View>
            <Text style={styles.sectionTitle}>外观主题</Text>
          </View>
          <Text style={styles.settingsDesc}>夜间建议使用深色，设置立即生效并只保存在本机。</Text>
          <View style={styles.segmentRow}>
            {(
              [
                { key: 'system', label: '跟随系统' },
                { key: 'light', label: '浅色' },
                { key: 'dark', label: '深色' },
              ] as Array<{ key: ThemePreference; label: string }>
            ).map((opt) => {
              const active = themePref === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.segmentItem, active && styles.segmentItemActive]}
                  onPress={() => applyThemePref(opt.key)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.success}20` }]}>
              <Ionicons name="lock-closed-outline" size={20} color={T.success} />
            </View>
            <Text style={styles.sectionTitle}>隐私与数据</Text>
          </View>
          <Text style={styles.settingsDesc}>
            录音与识别全在本机完成，不上传数据；录音保留 3 天自动清理，历史记录仅存于本机。
          </Text>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: T.primary }]}
            onPress={openPrivacyPolicy}
          >
            <Ionicons name="document-text-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
            <Text style={styles.actionButtonText}>查看隐私政策</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.danger}20` }]}>
              <Ionicons name="battery-charging-outline" size={20} color={T.danger} />
            </View>
            <Text style={styles.sectionTitle}>后台运行</Text>
          </View>
          <Text style={styles.settingsDesc}>
            息屏后持续录音需允许后台运行，部分品牌（小米 / 华为 / OPPO / vivo）还需在省电策略中关闭限制。
          </Text>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: T.danger }]}
            onPress={openBatterySettings}
          >
            <Ionicons name="shield-checkmark-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
            <Text style={styles.actionButtonText}>去设置后台权限</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        <View style={styles.settingSection}>
          <View style={styles.settingHeader}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.warning}20` }]}>
              <Ionicons name="trash-outline" size={20} color={T.warning} />
            </View>
            <Text style={styles.sectionTitle}>存储空间</Text>
          </View>
          <Text style={styles.settingsDesc}>
            清理过期录音和缓存，释放空间（历史记录不会被删除）。
          </Text>

          <View style={[styles.settingHeader, { marginTop: 4 }]}>
            <View style={[styles.settingIconCircle, { backgroundColor: `${T.snore}20` }]}>
              <Ionicons name="save-outline" size={20} color={T.snore} />
            </View>
            <Text style={styles.sectionTitle}>保存整夜录音</Text>
          </View>
          <Text style={styles.settingsDesc}>
            关闭后不再写入 WAV（整晚约 1GB），鼾声统计照常，但该晚录音无法回放。
          </Text>
          <View style={styles.segmentRow}>
            {(
              [
                { key: true, label: '保存' },
                { key: false, label: '不保存' },
              ] as Array<{ key: boolean; label: string }>
            ).map((opt) => {
              const active = saveRecording === opt.key;
              return (
                <TouchableOpacity
                  key={opt.label}
                  style={[styles.segmentItem, active && styles.segmentItemActive]}
                  onPress={() => applySaveRecordingPref(opt.key)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: T.warning, marginTop: 12 }]}
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
            <Ionicons name="sparkles-outline" size={16} color={T.onAccent} style={{ marginRight: 6 }} />
            <Text style={styles.actionButtonText}>清理缓存</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style={isDarkTheme ? 'light' : 'dark'} />
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
              <Ionicons name="cloud-download-outline" size={32} color={T.primary} />
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
