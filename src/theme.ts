/**
 * 设计 token（明/暗双套）。
 *
 * 睡眠类应用的核心使用场景是 23:00 躺在床上，纯白背景 + 高亮卡片在夜间非常刺眼，
 * 因此这里把原 App.tsx 中散落的硬编码色值统一收敛为语义 token，
 * 由 makeStyles(T) 按主题生成样式表。
 *
 * 所有文本色与所搭配表面色的对比度均 ≥ 4.5:1（核对脚本见交付说明），
 * 彩色填充块统一使用 onAccent 作为前景色。
 */

export type ColorSchemeName = 'light' | 'dark' | null | undefined;

/** 间距阶：4 / 8 / 12 / 16 / 24 / 32，禁止出现阶外数值 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 圆角阶：控件 8/12，卡片 16/20，胶囊用 999 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** 字号阶：数字展示 / 页面标题 / 区块标题 / 正文 / 说明 / 极小说明 */
export const fontSize = {
  display: 32,
  metric: 24,
  title: 20,
  section: 16,
  body: 14,
  caption: 12,
  micro: 11,
} as const;

/** 常用字重：正文常规 400，强调 600/700，数字与标题 800 */
export const fontWeight = {
  regular: '400',
  medium: '600',
  bold: '700',
  heavy: '800',
} as const;

/** 触摸区高度：任何可点控件不低于 48，分段控件 44 */
export const control = {
  touch: 48,
  segment: 44,
} as const;

export interface Theme {
  /** 明暗模式标记：暗色下卡片改用描边而非投影 */
  mode: 'light' | 'dark';
  /** 主题主色 */
  primary: string;
  primaryDark: string;
  /** 主色作为文字/图标画在卡片表面时使用的深（浅色主题）/亮（深色主题）一档 */
  primaryText: string;
  /** 强调/危险按钮 */
  danger: string;
  dangerDark: string;
  /** 警示（图标/进度） */
  warning: string;
  success: string;
  /** 语义色作为文字时的前景色 */
  successText: string;
  warningText: string;
  dangerText: string;

  /** 文本三级 */
  text: string;
  textSecondary: string;
  textTertiary: string;

  /** 表面 */
  background: string;
  card: string;
  /** 卡片内嵌的次级表面（统计格、音量条底槽等） */
  tile: string;
  border: string;
  /** 次要按钮底与其前景（低强调操作，如“恢复默认”） */
  secondary: string;
  secondaryFg: string;

  /** 事件语义色（填充：图标底、左边线） */
  snore: string;
  grind: string;
  talk: string;
  apnea: string;
  noise: string;
  /** 事件语义色作为文字时的前景色 */
  snoreText: string;
  grindText: string;
  talkText: string;
  apneaText: string;

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
  mode: 'light',
  primary: '#4ECDC4',
  primaryDark: '#3DBDB5',
  primaryText: '#0B7C74',
  danger: '#FF6B6B',
  dangerDark: '#E85C5C',
  warning: '#FFD93D',
  success: '#2ECC71',
  successText: '#127C3E',
  warningText: '#8A5B00',
  dangerText: '#B3241F',

  text: '#16212E',
  textSecondary: '#566675',
  textTertiary: '#5E6E7E',

  background: '#F4F6F8',
  card: '#FFFFFF',
  tile: '#F4F6F8',
  border: '#E4E9EF',
  secondary: '#E6EBF0',
  secondaryFg: '#2E3B4B',

  snore: '#4ECDC4',
  grind: '#FFD93D',
  talk: '#9B59B6',
  apnea: '#FF6B6B',
  noise: '#7A8B9C',
  snoreText: '#0B7C74',
  grindText: '#8A5B00',
  talkText: '#6633A6',
  apneaText: '#B3241F',

  qualityMid: '#E8B930',
  dangerStrong: '#D93B2B',

  warningBg: '#FFF4E0',
  warningFg: '#8A4B00',
  infoBg: '#E7F1FD',
  infoFg: '#0B4FA6',

  onAccent: '#10202D',
  successTint: '#2ECC7115',

  shadow: '#16212E',
  shadowOpacityScale: 1,
};

export const darkTheme: Theme = {
  mode: 'dark',
  primary: '#4ECDC4',
  primaryDark: '#5FDDD5',
  primaryText: '#6FE7DF',
  danger: '#FF7B7B',
  dangerDark: '#F06565',
  warning: '#FFD93D',
  success: '#3DDC84',
  successText: '#6FE39B',
  warningText: '#FFD93D',
  dangerText: '#FF8F8F',

  text: '#E8EEF5',
  textSecondary: '#A9B7C6',
  textTertiary: '#91A2B4',
  background: '#0B1219',
  card: '#182430',
  tile: '#111B26',
  border: '#273445',
  secondary: '#26323F',
  secondaryFg: '#DCE6EF',

  snore: '#4ECDC4',
  grind: '#FFD93D',
  talk: '#B07BD1',
  apnea: '#FF8A80',
  noise: '#A9B7C6',
  snoreText: '#6FE7DF',
  grindText: '#FFD93D',
  talkText: '#CB9FF0',
  apneaText: '#FF9A8F',

  qualityMid: '#FFCB4D',
  dangerStrong: '#FF7A66',

  warningBg: '#38290F',
  warningFg: '#FFC26B',
  infoBg: '#10283D',
  infoFg: '#8CC8FF',

  onAccent: '#0D141C',
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
