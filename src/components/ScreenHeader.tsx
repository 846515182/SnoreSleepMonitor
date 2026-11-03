import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AppStyles } from '../styles';
import type { Theme } from '../theme';

interface ScreenHeaderProps {
  title: string;
  onBack: () => void;
  T: Theme;
  styles: AppStyles;
}

/**
 * 二级页面顶栏：固定在内容之上，不再随 ScrollView 滚动。
 * 三个格子（返回 48 / 标题 / 右侧占位 48）保证标题始终居中。
 */
export function ScreenHeader({ title, onBack, T, styles }: ScreenHeaderProps) {
  return (
    <View style={styles.headerBar}>
      <TouchableOpacity
        style={styles.headerBack}
        onPress={onBack}
        activeOpacity={0.7}
        accessibilityRole="button"
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Ionicons name="chevron-back" size={26} color={T.primaryText} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSide} />
    </View>
  );
}
