// 由 App.tsx 抽离的样式表工厂：所有颜色引用主题 token，所有间距/字号/圆角引用 theme 里的阶。
// 由脚本从 App.tsx 的 StyleSheet.create 抽离后手工校订，勿在 App.tsx 内再维护样式。

import { StatusBar as RNStatusBar, StyleSheet } from 'react-native';
import { control, fontSize, fontWeight, radius, spacing } from './theme';
import type { Theme } from './theme';

/** 卡片策略：浅色用极轻投影，深色改用 1px 描边（暗色投影不可见且显脏） */
const surface = (T: Theme) =>
  T.mode === 'dark'
    ? {
        backgroundColor: T.card,
        borderWidth: 1,
        borderColor: T.border,
      }
    : {
        backgroundColor: T.card,
        shadowColor: T.shadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06 * T.shadowOpacityScale,
        shadowRadius: 12,
        elevation: 2,
      };

export const makeStyles = (T: Theme) =>
  StyleSheet.create({
    // ————————————————— 基础 —————————————————
    container: {
      flex: 1,
      backgroundColor: T.background,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    flex: {
      flex: 1,
    },
    loadingText: {
      marginTop: spacing.lg,
      color: T.textSecondary,
      fontSize: fontSize.body,
    },
    page: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    /** 首页底部留出安全区，主按钮不与手势条贴边 */
    homeContent: {
      padding: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
      gap: spacing.md,
    },
    card: {
      ...surface(T),
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
    },
    sectionTitle: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.text,
    },
    sectionTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    divider: {
      height: 1,
      backgroundColor: T.border,
    },

    // ————————————————— 顶部导航 —————————————————
    headerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: (RNStatusBar.currentHeight || 0) > 0 ? spacing.sm : spacing.md,
      paddingBottom: spacing.sm,
      backgroundColor: T.card,
      borderBottomWidth: 1,
      borderBottomColor: T.border,
    },
    headerBack: {
      width: control.touch,
      height: control.touch,
      alignItems: 'flex-start',
      justifyContent: 'center',
    },
    headerTitle: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.text,
      letterSpacing: 0.2,
    },
    headerSide: {
      width: control.touch,
      height: control.touch,
    },

    // ————————————————— 首页 —————————————————
    appBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    appIconCircle: {
      width: 44,
      height: 44,
      borderRadius: radius.md,
      backgroundColor: T.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    heroTitleBlock: {
      flex: 1,
    },
    title: {
      fontSize: fontSize.title,
      fontWeight: fontWeight.heavy,
      color: T.text,
    },
    subtitle: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      marginTop: spacing.xs,
    },
    updateBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: `${T.danger}80`,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.md,
      minHeight: 32,
    },
    updateBadgeText: {
      color: T.dangerText,
      fontSize: fontSize.caption,
      fontWeight: fontWeight.bold,
    },
    navRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    navButton: {
      flex: 1,
      height: control.touch,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: T.border,
      backgroundColor: T.card,
    },
    navButtonText: {
      fontSize: fontSize.body,
      fontWeight: fontWeight.bold,
      color: T.primaryText,
    },

    // ————————————————— 计时区 —————————————————
    timerCard: {
      ...surface(T),
      borderRadius: radius.xl,
      padding: spacing.lg,
      gap: spacing.md,
    },
    timerZone: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.sm,
    },
    /** 计时圆盘：直径由 onLayout 自适应（宽高/圆角在 App.tsx 内联计算） */
    timerOrb: {
      backgroundColor: T.tile,
      borderWidth: 1,
      borderColor: T.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    timerValue: {
      fontWeight: fontWeight.bold,
      color: T.text,
      fontVariant: ['tabular-nums'],
      marginTop: spacing.sm,
    },
    timerPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: T.card,
      borderWidth: 1,
      borderColor: T.border,
      borderRadius: radius.pill,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.md,
      marginTop: spacing.md,
    },
    timerDot: {
      width: 8,
      height: 8,
      borderRadius: radius.pill,
    },
    timerLabel: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      fontWeight: fontWeight.bold,
      letterSpacing: 0.5,
    },
    mainButton: {
      height: control.touch,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    startButton: {
      backgroundColor: T.primary,
    },
    stopButton: {
      backgroundColor: T.danger,
    },
    mainButtonText: {
      color: T.onAccent,
      fontSize: fontSize.section,
      fontWeight: fontWeight.bold,
    },
    tipRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
    },
    tipText: {
      fontSize: fontSize.micro,
      color: T.textTertiary,
      flexShrink: 1,
    },

    // ————————————————— 统计格 —————————————————
    statsGrid: {
      flexDirection: 'row',
      alignItems: 'stretch',
    },
    statDivider: {
      width: 1,
      backgroundColor: T.border,
      marginVertical: spacing.xs,
    },
    statCard: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.xs,
      gap: spacing.xs,
    },
    statIconCircle: {
      width: 28,
      height: 28,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statValue: {
      fontSize: fontSize.metric,
      fontWeight: fontWeight.heavy,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    statLabel: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      fontWeight: fontWeight.medium,
    },
    statDuration: {
      fontSize: fontSize.micro,
      color: T.textTertiary,
      fontVariant: ['tabular-nums'],
    },

    // ————————————————— 实时音量 —————————————————
    volumeCard: {
      ...surface(T),
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
    },
    volumeHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    volumeLabel: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.bold,
      color: T.text,
    },
    volumeHeaderValue: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    volumeBarBg: {
      height: 10,
      backgroundColor: T.border,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    volumeBarFill: {
      height: '100%',
      borderRadius: radius.pill,
    },
    volumeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    volumeState: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      fontWeight: fontWeight.medium,
    },
    volumeDb: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      fontVariant: ['tabular-nums'],
    },

    // ————————————————— 提示条 —————————————————
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: 52,
    },
    bannerWarning: {
      backgroundColor: T.warningBg,
    },
    bannerInfo: {
      backgroundColor: T.infoBg,
    },
    bannerText: {
      flex: 1,
      fontSize: fontSize.caption,
      lineHeight: 18,
    },
    bannerTextWarning: {
      color: T.warningFg,
    },
    bannerTextInfo: {
      color: T.infoFg,
    },
    bannerAction: {
      minHeight: 44,
      justifyContent: 'center',
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
    },
    bannerActionWarning: {
      backgroundColor: T.warningFg,
    },
    bannerActionInfo: {
      backgroundColor: T.infoFg,
    },
    bannerActionText: {
      color: T.onAccent,
      fontSize: fontSize.caption,
      fontWeight: fontWeight.bold,
    },

    // ————————————————— 历史列表 —————————————————
    historyList: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    historyItem: {
      ...surface(T),
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    historyMain: {
      flex: 1,
      gap: spacing.xs,
    },
    historyTime: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    historyMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    historyMeta: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
    },
    historyCountRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    historyCount: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: T.tile,
      borderRadius: radius.sm,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
    },
    historyCountText: {
      fontSize: fontSize.caption,
      fontWeight: fontWeight.bold,
      fontVariant: ['tabular-nums'],
    },
    historyRight: {
      alignItems: 'flex-end',
      gap: spacing.sm,
    },
    historyChevron: {
      alignSelf: 'center',
    },
    qualityBadge: {
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      minWidth: 62,
      alignItems: 'center',
    },
    qualityText: {
      color: T.onAccent,
      fontWeight: fontWeight.heavy,
      fontSize: fontSize.caption,
    },
    apneaRiskBadge: {
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      minWidth: 62,
      alignItems: 'center',
    },
    apneaRiskText: {
      color: T.onAccent,
      fontWeight: fontWeight.heavy,
      fontSize: fontSize.caption,
    },
    emptyBox: {
      alignItems: 'center',
      paddingTop: 64,
      gap: spacing.md,
      paddingHorizontal: spacing.xl,
    },
    emptyIconCircle: {
      width: 88,
      height: 88,
      borderRadius: radius.xl,
      backgroundColor: `${T.primary}12`,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyText: {
      color: T.text,
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
    },
    emptySubText: {
      color: T.textSecondary,
      fontSize: fontSize.caption,
      textAlign: 'center',
      lineHeight: 18,
    },

    // ————————————————— 记录详情 —————————————————
    detailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    detailIconCircle: {
      width: 44,
      height: 44,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    detailTitleBlock: {
      flex: 1,
    },
    detailTime: {
      fontSize: fontSize.title,
      fontWeight: fontWeight.heavy,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    detailSubTime: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      marginTop: spacing.xs,
    },
    /** 详情页计数格：四列等宽，同一卡片内不留手工 margin */
    detailStatsGrid: {
      flexDirection: 'row',
      alignItems: 'stretch',
    },
    detailStatCard: {
      flex: 1,
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.xs,
    },
    detailStatValue: {
      fontSize: fontSize.body,
      fontWeight: fontWeight.heavy,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    detailStatLabel: {
      fontSize: fontSize.micro,
      color: T.textSecondary,
    },
    /** 时长/事件这类次要指标用行式列表，弱于上方计数格 */
    metricList: {
      borderRadius: radius.md,
      backgroundColor: T.tile,
      paddingHorizontal: spacing.md,
    },
    metricRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
    metricRowDivider: {
      height: 1,
      backgroundColor: T.border,
    },
    metricRowLabel: {
      flex: 1,
      fontSize: fontSize.body,
      color: T.textSecondary,
    },
    metricRowValue: {
      fontSize: fontSize.body,
      fontWeight: fontWeight.bold,
      color: T.text,
      fontVariant: ['tabular-nums'],
    },
    badgePair: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    qualityBadgeLarge: {
      flex: 1,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    qualityTextLarge: {
      color: T.onAccent,
      fontSize: fontSize.body,
      fontWeight: fontWeight.heavy,
      textAlign: 'center',
    },
    intensityRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    intensityBlock: {
      flex: 1,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      alignItems: 'center',
      gap: spacing.xs,
    },
    recordingBox: {
      gap: spacing.md,
    },
    clipButton: {
      height: control.touch,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: `${T.primary}14`,
      borderWidth: 1,
      borderColor: `${T.primary}59`,
    },
    clipButtonDisabled: {
      opacity: 0.45,
    },
    clipButtonText: {
      color: T.primaryText,
      fontSize: fontSize.body,
      fontWeight: fontWeight.bold,
    },
    clipProgressText: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    emptyRecordingBox: {
      alignItems: 'center',
      backgroundColor: T.card,
      borderWidth: 1,
      borderColor: T.border,
      borderRadius: radius.md,
      paddingVertical: spacing.xl,
      gap: spacing.sm,
    },
    emptyEventBox: {
      alignItems: 'center',
      backgroundColor: T.successTint,
      borderRadius: radius.md,
      paddingVertical: spacing.xl,
      gap: spacing.sm,
    },
    noRecordingText: {
      color: T.textSecondary,
      fontSize: fontSize.caption,
    },
    disclaimerText: {
      color: T.textSecondary,
      fontSize: fontSize.caption,
      lineHeight: 18,
    },
    timeline: {
      gap: spacing.sm,
    },
    eventRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      backgroundColor: T.tile,
      borderRadius: radius.md,
      borderLeftWidth: 3,
    },
    eventIconCircle: {
      width: 36,
      height: 36,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eventBody: {
      flex: 1,
      gap: spacing.xs,
    },
    eventIndex: {
      fontWeight: fontWeight.bold,
      fontSize: fontSize.body,
    },
    eventClock: {
      color: T.textSecondary,
      fontSize: fontSize.caption,
      fontVariant: ['tabular-nums'],
    },
    deleteButton: {
      height: control.touch,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: T.danger,
    },

    // ————————————————— 设置 —————————————————
    settingSection: {
      gap: spacing.md,
    },
    settingHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    settingIconCircle: {
      width: 36,
      height: 36,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    settingsDesc: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      lineHeight: 19,
    },
    thresholdValue: {
      fontSize: fontSize.display,
      fontWeight: fontWeight.heavy,
      color: T.text,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    sliderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    adjustButton: {
      width: control.touch,
      height: control.touch,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    adjustButtonText: {
      fontSize: fontSize.title,
      fontWeight: fontWeight.bold,
      lineHeight: 24,
    },
    thresholdTrack: {
      flex: 1,
      height: 10,
      backgroundColor: T.border,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    thresholdFill: {
      height: '100%',
      borderRadius: radius.pill,
    },
    actionButton: {
      height: control.touch,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    actionButtonText: {
      color: T.onAccent,
      fontSize: fontSize.body,
      fontWeight: fontWeight.bold,
    },
    secondaryButton: {
      height: control.touch,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: T.secondary,
      paddingHorizontal: spacing.md,
    },
    secondaryButtonText: {
      color: T.secondaryFg,
      fontSize: fontSize.body,
      fontWeight: fontWeight.bold,
    },
    versionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    newVersionBadge: {
      backgroundColor: `${T.danger}18`,
      borderRadius: radius.sm,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.md,
    },
    newVersionBadgeText: {
      color: T.dangerText,
      fontSize: fontSize.caption,
      fontWeight: fontWeight.bold,
    },

    // ————————————————— 分段控件 —————————————————
    segmentRow: {
      flexDirection: 'row',
      backgroundColor: T.border,
      borderRadius: radius.md,
      padding: spacing.xs,
      gap: spacing.xs,
    },
    segmentItem: {
      flex: 1,
      height: 40,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentItemActive: {
      backgroundColor: T.card,
      shadowColor: T.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08 * T.shadowOpacityScale,
      shadowRadius: 3,
      elevation: 1,
    },
    segmentText: {
      fontSize: fontSize.body,
      fontWeight: fontWeight.medium,
      color: T.textSecondary,
    },
    segmentTextActive: {
      color: T.primaryText,
      fontWeight: fontWeight.heavy,
    },

    // ————————————————— 首次启动隐私同意页 —————————————————
    consentBullet: {
      fontSize: fontSize.body,
      lineHeight: 22,
      color: T.textSecondary,
    },
    consentLink: {
      fontSize: fontSize.body,
      fontWeight: fontWeight.medium,
      color: T.primaryText,
      textAlign: 'center',
      paddingVertical: spacing.md,
    },

    // ————————————————— 弹窗 —————————————————
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
    },
    updateModal: {
      width: '100%',
      maxWidth: 320,
      ...surface(T),
      borderRadius: radius.xl,
      padding: spacing.xl,
      alignItems: 'center',
      gap: spacing.md,
      elevation: 10,
    },
    updateIconCircle: {
      width: 64,
      height: 64,
      borderRadius: radius.xl,
      backgroundColor: `${T.primary}15`,
      alignItems: 'center',
      justifyContent: 'center',
    },
    updateModalTitle: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.text,
    },
    updateModalStatus: {
      fontSize: fontSize.caption,
      color: T.textSecondary,
      textAlign: 'center',
    },
    progressTrack: {
      width: '100%',
      height: 10,
      backgroundColor: T.border,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: T.primary,
      borderRadius: radius.pill,
    },
    updateModalPercent: {
      fontSize: fontSize.section,
      fontWeight: fontWeight.heavy,
      color: T.primaryText,
    },
  });

export type AppStyles = ReturnType<typeof makeStyles>;
