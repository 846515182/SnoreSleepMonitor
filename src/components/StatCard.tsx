import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AppStyles } from '../styles';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface StatCardProps {
  icon: IconName;
  color: string;
  value: string | number;
  label: string;
  /** 首页卡片显示次数下方的累计时长 */
  subText?: string;
  variant: 'home' | 'detail';
  styles: AppStyles;
}

/**
 * 首页 4 张统计格与详情页 4 张计数格的统一实现。
 * 两种变体只差字号与图标尺寸，列宽由父级等分，不再手写 width。
 */
export function StatCard({ icon, color, value, label, subText, variant, styles }: StatCardProps) {
  if (variant === 'home') {
    return (
      <View style={styles.statCard}>
        <View style={[styles.statIconCircle, { backgroundColor: `${color}18` }]}>
          <Ionicons name={icon} size={16} color={color} />
        </View>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
        {subText !== undefined && <Text style={styles.statDuration}>{subText}</Text>}
      </View>
    );
  }
  return (
    <View style={styles.detailStatCard}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={styles.detailStatValue}>{value}</Text>
      <Text style={styles.detailStatLabel}>{label}</Text>
    </View>
  );
}
