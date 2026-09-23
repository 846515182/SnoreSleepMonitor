/**
 * 版本号解析与比较（纯函数，供检查更新与单元测试复用）。
 */

export function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

/**
 * 比较两个语义版本字符串。
 * @returns local < remote 返回 -1；相等返回 0；local > remote 返回 1
 */
export function compareVersion(local: string, remote: string): number {
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
