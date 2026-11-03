import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AppStyles } from '../styles';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface MetricRowProps {
  icon: IconName;
  color: string;
  label: string;
  value: string | number;
  /** 非最后一行时画分隔线，行距统一由样式表控制 */
  divider?: boolean;
  styles: AppStyles;
}

/** 详情页次要指标行：标签在左、数值在右，弱于上方计数格的视觉权重 */
export function MetricRow({ icon, color, label, value, divider = true, styles }: MetricRowProps) {
  return (
    <>
      <View style={styles.metricRow}>
        <Ionicons name={icon} size={18} color={color} />
        <Text style={styles.metricRowLabel}>{label}</Text>
        <Text style={styles.metricRowValue}>{value}</Text>
      </View>
      {divider && <View style={styles.metricRowDivider} />}
    </>
  );
}
