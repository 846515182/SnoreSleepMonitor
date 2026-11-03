// 应用内更新器：GitHub Releases 检查、APK 下载、完整性校验、缓存清理与安装。
// 安全底线：只接受本仓库 Releases 地址；下载后必须校验大小；Release 提供 SHA256SUMS 时
// 必须校验 SHA-256，不匹配一律拒绝安装；无法校验时必须由用户显式确认，不允许静默跳过。

import { Alert, Linking, NativeModules, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';

import { formatBytes } from '../utils/format';

const GITHUB_OWNER = '846515182';
const GITHUB_REPO = 'SnoreSleepMonitor';
const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

/** 更新包只接受本仓库 Releases 下发的地址（防止接口被投毒后下载到第三方 APK） */
export const EXPECTED_DOWNLOAD_PREFIX = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`;

const MAX_CACHED_APKS = 3;
const MIN_APK_BYTES = 1024 * 1024;
const CHECKSUM_TIMEOUT_MS = 15000;
const PROGRESS_EMIT_STEP = 0.01;

const AudioMeter = NativeModules.AudioMeter as
  | { sha256File?: (path: string) => Promise<string> }
  | undefined;

export interface LatestRelease {
  version: string;
  downloadUrl: string;
  body: string;
  size?: number;
  /** Release 中的 SHA256SUMS 资产地址；缺失时无法做哈希校验 */
  checksumUrl?: string;
  checksumName?: string;
}

export interface DownloadSnapshot {
  downloading: boolean;
  progress: number;
  status: string;
}

export interface UpdateHandlers {
  onDownloading?: (downloading: boolean) => void;
  onProgress?: (progress: number) => void;
  onStatus?: (status: string) => void;
}

export interface InstallOptions {
  downloadUrl: string;
  expectedSize?: number;
  checksumUrl?: string;
  /** 需要保留、不能被“清理缓存”删掉的文件 URI（录音、片段等） */
  protectedUris?: string[];
  handlers?: UpdateHandlers;
}

function getCurrentVersion(): string {
  return (Constants.expoConfig?.version as string) || '0.0.0';
}

function cachePath(name: string): string {
  const dir = FileSystem.cacheDirectory || '';
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function assertRepoUrl(url: string, label: string): boolean {
  if (!url.startsWith(EXPECTED_DOWNLOAD_PREFIX)) {
    console.warn(`更新地址校验失败：${label}不是本仓库 Releases 资源`, url);
    return false;
  }
  return true;
}

async function fetchText(url: string, timeoutMs = CHECKSUM_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/plain', 'User-Agent': `${GITHUB_REPO}/${getCurrentVersion()}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(GITHUB_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${GITHUB_REPO}/${getCurrentVersion()}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 403) {
        console.warn('GitHub API 频率受限，请稍后再试');
      }
      return null;
    }
    const data = await res.json();
    type Asset = { name?: string; browser_download_url?: string; size?: number };
    const assets: Asset[] = Array.isArray(data.assets) ? data.assets : [];
    const apkAsset = assets.find((a) => a.name?.endsWith('.apk'));
    if (!apkAsset?.browser_download_url) return null;
    if (!assertRepoUrl(apkAsset.browser_download_url, 'APK')) return null;

    const checksumAsset = assets.find(
      (a) => a.name === 'SHA256SUMS' || a.name === 'sha256sums' || a.name?.endsWith('.sha256')
    );
    const checksumUrl =
      checksumAsset?.browser_download_url && assertRepoUrl(checksumAsset.browser_download_url, 'SHA256SUMS')
        ? checksumAsset.browser_download_url
        : undefined;

    return {
      version: data.tag_name || '',
      downloadUrl: apkAsset.browser_download_url,
      body: data.body || '',
      size: typeof apkAsset.size === 'number' ? apkAsset.size : undefined,
      checksumUrl,
      checksumName: checksumAsset?.name,
    };
  } catch (e) {
    console.warn('检查更新失败', e);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function openUpdateUrl(url: string): Promise<void> {
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
}

/** 清理旧 APK 缓存，保留最近 MAX_CACHED_APKS 个，避免占用空间并确保覆盖安装干净 */
export async function cleanUpdateCache(keepFileName?: string): Promise<void> {
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
}

/** 清理应用缓存目录（不包括要安装的 APK、正在使用/被历史引用的录音） */
export async function cleanAppCache(excludeApkName?: string, protectedUris: string[] = []): Promise<void> {
  try {
    if (!FileSystem.cacheDirectory) return;
    const protectedSet = new Set(protectedUris.filter(Boolean));
    const entries = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    await Promise.all(
      entries.map(async (name) => {
        if (name === excludeApkName) return;
        if (name.startsWith('update_') && name.endsWith('.apk')) return; // 由 cleanUpdateCache 管理
        const itemUri = cachePath(name);
        if (protectedSet.has(itemUri)) return;
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
}

function parseChecksumHashes(text: string, apkName: string): string[] {
  const lines = text.split(/\r?\n/);
  const forApk: string[] = [];
  const anyHash: string[] = [];
  for (const line of lines) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?/);
    if (!m) continue;
    anyHash.push(m[1].toLowerCase());
    const fileName = m[2];
    if (fileName && apkName && fileName.endsWith(apkName)) {
      forApk.push(m[1].toLowerCase());
    }
  }
  return forApk.length > 0 ? forApk : anyHash;
}

async function sha256OfFile(uri: string): Promise<string | null> {
  if (typeof AudioMeter?.sha256File !== 'function') return null;
  try {
    const hash = await AudioMeter.sha256File(uri.replace('file://', ''));
    return typeof hash === 'string' && /^[a-fA-F0-9]{64}$/.test(hash) ? hash.toLowerCase() : null;
  } catch (e) {
    console.warn('计算 APK SHA-256 失败', e);
    return null;
  }
}

function confirmOverwriteInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      '覆盖安装确认',
      '下载完成后将使用新版 APK 覆盖安装旧版，并清理应用缓存（不会影响历史记录）。是否继续？',
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: '继续', onPress: () => resolve(true) },
      ],
      { cancelable: false }
    );
  });
}

function confirmUnverifiedInstall(reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      '无法校验更新包',
      `${reason}\n\n继续安装将跳过完整性校验，存在被篡改的风险。是否仍要安装？`,
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: '仍然安装', onPress: () => resolve(true) },
      ],
      { cancelable: false }
    );
  });
}

async function verifyApk(
  fileUri: string,
  fileName: string,
  apkName: string,
  checksumUrl?: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!checksumUrl) {
    return { ok: false, reason: '当前 Release 未提供 SHA256SUMS 校验文件。' };
  }
  let text: string;
  try {
    text = await fetchText(checksumUrl);
  } catch (e) {
    return { ok: false, reason: `无法下载 SHA256SUMS（${e instanceof Error ? e.message : String(e)}）。` };
  }
  const hashes = parseChecksumHashes(text, apkName);
  if (hashes.length === 0) {
    return { ok: false, reason: 'SHA256SUMS 内容为空或格式无法识别。' };
  }
  const localHash = await sha256OfFile(fileUri);
  if (!localHash) {
    return { ok: false, reason: '本机无法计算 APK 的 SHA-256。' };
  }
  if (!hashes.includes(localHash)) {
    return { ok: false, reason: `SHA-256 不匹配。\n本地：${localHash}` };
  }
  console.warn(`更新包 SHA-256 校验通过：${fileName}`);
  return { ok: true };
}

async function promptInstallPermission(): Promise<void> {
  Alert.alert('需要安装权限', '系统未允许本应用安装 APK，请在设置中开启「允许安装未知来源应用」。', [
    { text: '取消', style: 'cancel' },
    {
      text: '去开启',
      onPress: async () => {
        try {
          if (Platform.OS === 'android' && Platform.Version && Number(Platform.Version) >= 26) {
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
  ]);
}

// 下载任务句柄与代次：取消/重开后，旧任务的回调不能再动 UI 或清掉新任务句柄。
let activeTask: FileSystem.DownloadResumable | null = null;
let activeTaskId = 0;
let inFlight = false;
let activeHandlers: UpdateHandlers = {};

export function cancelActiveDownload(): DownloadSnapshot {
  activeTaskId += 1;
  const task = activeTask;
  activeTask = null;
  inFlight = false;
  const handlers = activeHandlers;
  if (task) task.cancelAsync().catch((e) => console.warn('取消下载失败', e));
  handlers.onDownloading?.(false);
  handlers.onProgress?.(0);
  handlers.onStatus?.('已取消下载');
  return { downloading: false, progress: 0, status: '已取消下载' };
}

/** 下载并安装 APK：大小校验 → SHA-256 校验 → 清理缓存 → 拉起安装器 */
export async function downloadAndInstallApk(
  options: InstallOptions,
  cleanOldRecordings?: () => Promise<void>
): Promise<void> {
  const { downloadUrl, expectedSize, checksumUrl, protectedUris = [], handlers = {} } = options;

  // 下载入口再次校验地址：即使 UI 层传入被篡改的 release 对象也不会下载第三方包。
  if (!assertRepoUrl(downloadUrl, 'APK')) {
    Alert.alert('更新失败', '更新包地址不在本仓库 Releases 范围内，已拒绝下载。');
    return;
  }
  if (checksumUrl && !assertRepoUrl(checksumUrl, 'SHA256SUMS')) {
    Alert.alert('更新失败', '校验文件地址不在本仓库 Releases 范围内，已拒绝下载。');
    return;
  }
  if (inFlight) {
    Alert.alert('正在下载', '更新包还在下载中，请稍候。');
    return;
  }
  if (Platform.OS !== 'android') {
    await openUpdateUrl(downloadUrl);
    return;
  }
  if (!(await confirmOverwriteInstall())) return;

  activeHandlers = handlers;
  const taskId = (activeTaskId += 1);
  inFlight = true;
  handlers.onDownloading?.(true);
  handlers.onProgress?.(0);

  const fileName = `update_${Date.now()}.apk`;
  const fileUri = cachePath(fileName);
  const apkName = downloadUrl.split('/').pop() || fileName;
  let stage: 'download' | 'verify' | 'install' = 'download';
  let lastPct = -1;

  try {
    await cleanUpdateCache(fileName);
    if (cleanOldRecordings) await cleanOldRecordings();

    handlers.onStatus?.(
      expectedSize ? `正在下载… 0% / ${formatBytes(expectedSize)}` : '正在下载…'
    );
    const resumable = FileSystem.createDownloadResumable(downloadUrl, fileUri, {}, (progress) => {
      if (activeTaskId !== taskId) return;
      const total = progress.totalBytesExpectedToWrite || expectedSize || 1;
      const written = progress.totalBytesWritten || 0;
      const pct = Math.min(1, Math.max(0, written / total));
      if (Math.abs(pct - lastPct) < PROGRESS_EMIT_STEP && pct < 1) return;
      lastPct = pct;
      handlers.onProgress?.(pct);
      handlers.onStatus?.(
        `正在下载… ${Math.round(pct * 100)}%${expectedSize ? ` / ${formatBytes(expectedSize)}` : ''}`
      );
    });
    activeTask = resumable;

    const result = await resumable.downloadAsync();
    if (activeTaskId !== taskId) return;
    activeTask = null;
    if (!result) throw new Error('下载失败，请检查网络');
    stage = 'verify';

    // 1) 大小校验：至少 1MB，并与 GitHub 声明的大小一致（允许 ±1% 误差）
    const fileInfo = await FileSystem.getInfoAsync(result.uri);
    const fileSize = fileInfo.exists ? fileInfo.size ?? 0 : 0;
    if (!fileInfo.exists || fileSize < MIN_APK_BYTES) {
      throw new Error('下载文件异常，请重试');
    }
    if (expectedSize && expectedSize > 0) {
      const ratio = fileSize / expectedSize;
      if (ratio < 0.99 || ratio > 1.01) {
        throw new Error(
          `文件大小校验失败，请重试（${formatBytes(fileSize)} / ${formatBytes(expectedSize)}）`
        );
      }
    }

    // 2) 完整性校验：有 SHA256SUMS 时必须匹配；无校验文件/本机无法计算时，必须用户显式确认。
    handlers.onStatus?.('正在校验更新包完整性…');
    const check = await verifyApk(result.uri, fileName, apkName, checksumUrl);
    if (!check.ok) {
      const proceed = await confirmUnverifiedInstall(check.reason || '无法校验更新包。');
      if (!proceed) {
        if (activeTaskId === taskId) {
          inFlight = false;
          handlers.onDownloading?.(false);
          handlers.onProgress?.(0);
          handlers.onStatus?.('已取消安装（完整性校验未通过）');
        }
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
        return;
      }
    }

    if (activeTaskId !== taskId) return;
    handlers.onStatus?.('下载完成，清理缓存并准备安装…');
    handlers.onProgress?.(1);

    // 3) 安装前清理应用自身缓存（保留刚下载的 APK），释放空间并减少旧数据干扰。
    await cleanAppCache(fileName, protectedUris);
    await cleanUpdateCache(fileName);

    // 4) 获取 content:// URI 并启动安装界面
    stage = 'install';
    const contentUri = await FileSystem.getContentUriAsync(result.uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });

    if (activeTaskId === taskId) {
      inFlight = false;
      handlers.onDownloading?.(false);
    }
  } catch (e) {
    if (activeTaskId !== taskId) return;
    activeTask = null;
    inFlight = false;
    handlers.onDownloading?.(false);
    handlers.onProgress?.(0);
    console.warn('下载或安装失败', e);
    if (stage === 'install') {
      await promptInstallPermission();
    } else {
      handlers.onStatus?.('更新失败');
      Alert.alert('更新失败', `原因：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
