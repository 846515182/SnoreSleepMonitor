import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AppStyles } from '../styles';
import type { Theme } from '../theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface InfoBannerProps {
  variant: 'warning' | 'info';
  icon: IconName;
  message: string;
  styles: AppStyles;
  T: Theme;
  action?: { label: string; onPress: () => void };
}

/** 提示条：权限缺失 / 兼容模式 / 记录中断，统一一套内边距与图标尺寸 */
export function InfoBanner({ variant, icon, message, styles, T, action }: InfoBannerProps) {
  const isWarning = variant === 'warning';
  const fg = isWarning ? T.warningFg : T.infoFg;
  return (
    <View style={[styles.banner, isWarning ? styles.bannerWarning : styles.bannerInfo]}>
      <Ionicons name={icon} size={20} color={fg} />
      <Text style={[styles.bannerText, isWarning ? styles.bannerTextWarning : styles.bannerTextInfo]}>
        {message}
      </Text>
      {action && (
        <TouchableOpacity
          style={[styles.bannerAction, isWarning ? styles.bannerActionWarning : styles.bannerActionInfo]}
          onPress={action.onPress}
          activeOpacity={0.85}
          accessibilityRole="button"
        >
          <Text style={styles.bannerActionText}>{action.label}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
