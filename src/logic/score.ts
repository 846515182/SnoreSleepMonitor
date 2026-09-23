/**
 * 睡眠质量评分（纯函数）。
 *
 * 说明：本评分只基于「监测时长 vs 被判定为异常声音的时长」的比例，
 * 属于声音维度的客观指标，不代表医学意义上的睡眠结构（入睡潜伏期、深睡比例等）。
 */

/** 声音占比 -> 0-100 分的指数衰减曲线 */
const SCORE_EXPONENT = 1.8;

export function calculateQualityScore(sleepSeconds: number, noiseSeconds: number): number {
  if (sleepSeconds <= 0) return 100;
  // Clamp ratio to [0, 1]; if more than half the night is noisy, score trends toward 0.
  const ratio = Math.min(1, noiseSeconds / sleepSeconds);
  // Smooth exponential decay: 5% noise -> ~91, 15% -> ~75, 30% -> ~53, 50% -> ~29.
  const score = 100 * Math.pow(1 - ratio, SCORE_EXPONENT);
  return Math.max(0, Math.min(100, Math.round(score)));
}
