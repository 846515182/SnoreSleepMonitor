import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { AppStyles } from '../styles';

export interface SegmentOption<K extends string | boolean> {
  key: K;
  label: string;
}

interface SegmentControlProps<K extends string | boolean> {
  options: ReadonlyArray<SegmentOption<K>>;
  value: K;
  onChange: (value: K) => void;
  styles: AppStyles;
  /** 阈值分类切换时，选中项文字使用当前类别颜色 */
  activeColor?: string;
}

/** 统一的二/三分段控件，替代主题、保存录音、整晚录音、降噪、阈值分类等重复实现 */
export function SegmentControl<K extends string | boolean>({
  options,
  value,
  onChange,
  styles,
  activeColor,
}: SegmentControlProps<K>) {
  return (
    <View style={styles.segmentRow}>
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <TouchableOpacity
            key={String(opt.key)}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
            onPress={() => onChange(opt.key)}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.segmentText,
                active && styles.segmentTextActive,
                active && activeColor ? { color: activeColor } : null,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
