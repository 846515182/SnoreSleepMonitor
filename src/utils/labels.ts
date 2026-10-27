/**
 * 展示层文案与语义色（依赖主题 token，故颜色函数需传入 Theme）。
 */

import type { ApneaRisk, SnoreIntensity, SoundEventType } from '../types';
import type { Theme } from '../theme';

export function getQualityColor(score: number, T: Theme): string {
  if (score >= 85) return T.success;
  if (score >= 60) return T.qualityMid;
  return T.dangerStrong;
}

export function getIntensityLabel(intensity: SnoreIntensity): string {
  switch (intensity) {
    case 'severe':
      return '重度';
    case 'moderate':
      return '中度';
    default:
      return '轻度';
  }
}

export function getApneaRiskColor(risk: ApneaRisk, T: Theme): string {
  switch (risk) {
    case 'high':
      return T.dangerStrong;
    case 'moderate':
      return T.qualityMid;
    default:
      return T.success;
  }
}

export function getApneaRiskLabel(risk: ApneaRisk): string {
  switch (risk) {
    case 'high':
      return '高风险';
    case 'moderate':
      return '中风险';
    default:
      return '低风险';
  }
}

export function getEventColor(type: SoundEventType, T: Theme): string {
  switch (type) {
    case 'snore':
      return T.snore;
    case 'grind':
      return T.qualityMid;
    case 'talk':
      return T.talk;
    case 'apnea':
      return T.dangerStrong;
    default:
      return T.noise;
  }
}

export function getEventLabel(
  type: SoundEventType,
  intensity?: SnoreIntensity
): string {
  const base =
    type === 'snore'
      ? '打鼾'
      : type === 'grind'
        ? '磨牙'
        : type === 'talk'
          ? '梦话'
          : type === 'apnea'
            ? '呼吸暂停'
            : '未知';
  if (type === 'snore' && intensity) {
    return `${base}(${getIntensityLabel(intensity)})`;
  }
  return base;
}
