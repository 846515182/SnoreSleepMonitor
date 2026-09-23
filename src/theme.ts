/**
 * 设计 token（明/暗双套）。
 *
 * 睡眠类应用的核心使用场景是 23:00 躺在床上，纯白背景 + 高亮卡片在夜间非常刺眼，
 * 因此这里把原 App.tsx 中散落的硬编码色值统一收敛为语义 token，
 * 由 makeStyles(T) 按主题生成样式表。
 */

export type ColorSchemeName = 'light' | 'dark' | null | undefined;

export interface Theme {
  /** 主题主色 */
  primary: string;
  primaryDark: string;
  /** 强调/危险按钮 */
  danger: string;
  dangerDark: string;
  /** 警示（图标/进度） */
  warning: string;
  success: string;

  /** 文本三级 */
  text: string;
  textSecondary: string;
  textTertiary: string;

  /** 表面 */
  background: string;
  card: string;
  border: string;

  /** 事件语义色 */
  snore: string;
  grind: string;
  talk: string;
  apnea: string;
  noise: string;

  /** 比语义色更深一档，用于文字/徽标底色上的前景 */
  qualityMid: string;
  dangerStrong: string;

  /** 提示条 */
  warningBg: string;
  warningFg: string;
  infoBg: string;
  infoFg: string;

  /** 彩色底上的前景色（按钮文字、徽标文字、彩色圆内的图标） */
  onAccent: string;
  /** 彩色底的 15% 透明底色 */
  successTint: string;

  /** 阴影色 */
  shadow: string;
  /** 阴影不透明度系数，暗色下减弱 */
  shadowOpacityScale: number;
}

export const lightTheme: Theme = {
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

  qualityMid: '#E8B930',
  dangerStrong: '#E74C3C',

  warningBg: '#FFF3E0',
  warningFg: '#E65100',
  infoBg: '#E3F2FD',
  infoFg: '#0B5FBF',

  onAccent: '#10202D',
  successTint: '#2ECC7115',

  shadow: '#1A2B3C',
  shadowOpacityScale: 1,
};

export const darkTheme: Theme = {
  primary: '#4ECDC4',
  primaryDark: '#5FDDD5',
  danger: '#FF7B7B',
  dangerDark: '#F06565',
  warning: '#FFD93D',
  success: '#3DDC84',

  text: '#E9EFF5',
  textSecondary: '#A2B3C4',
  textTertiary: '#7286 9A'.replace(' ', ''),
  background: '#0E1621',
  card: '#17212E',
  border: '#26323F',

  snore: '#4ECDC4',
  grind: '#FFD93D',
  talk: '#B07BD1',
  apnea: '#FF8A80',
  noise: '#A2B3C4',

  qualityMid: '#FFCB4D',
  dangerStrong: '#FF7A66',

  warningBg: '#3A2C13',
  warningFg: '#FFC46B',
  infoBg: '#123049',
  infoFg: '#7FC1FF',

  onAccent: '#0E1621',
  successTint: '#3DDC8418',

  shadow: '#000000',
  shadowOpacityScale: 0.5,
};

export const themes = { light: lightTheme, dark: darkTheme };

/**
 * 解析当前应使用的主题。
 * @param scheme 系统配色（useColorScheme）
 * @param preference 用户偏好：'system' 跟随系统 | 'light' | 'dark'
 */
export function resolveTheme(
  scheme: ColorSchemeName,
  preference: 'system' | 'light' | 'dark' = 'system'
): Theme {
  if (preference === 'light') return lightTheme;
  if (preference === 'dark') return darkTheme;
  return scheme === 'dark' ? darkTheme : lightTheme;
}
