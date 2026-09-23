/**
 * 展示层文案与语义色（依赖主题 token，故颜色函数需传入 Theme）。
 */

import type { ApneaRisk, SnoreIntensity, SoundEvent, SoundEventType } from '../types';
import type { Theme } from '../theme';

export function getQualityColor(score: number, T: Theme): string {
  if (score >= 85) return T.success;
  if (score >= 60) return T.qualityMid;
  return T.dangerStrong;
}

export function getIntensityColor(intensity: SnoreIntensity, T: Theme): string {
  switch (intensity) {
    case 'severe':
      return T.dangerStrong;
    case 'moderate':
      return T.qualityMid;
    default:
      return T.success;
  }
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

export function getClassLabel(classKey: string): string {
  switch (classKey) {
    case 'snoring':
      return '打鼾';
    case 'grinding':
      return '磨牙';
    case 'talking':
      return '梦话';
    case 'apnea':
      return '异常呼吸音';
    case 'noise':
      return '环境音';
    default:
      return classKey;
  }
}

/** 详情页单条事件的展示元信息 */
export function describeEvent(evt: SoundEvent, T: Theme) {
  return {
    color: getEventColor(evt.type, T),
    label: getEventLabel(evt.type, evt.intensity),
    iconName:
      evt.type === 'snore'
        ? 'volume-high-outline'
        : evt.type === 'grind'
          ? 'git-branch-outline'
          : evt.type === 'talk'
            ? 'chatbubble-outline'
            : 'pulse-outline',
  };
}
