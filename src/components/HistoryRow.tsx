import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getApneaRiskColor, getApneaRiskLabel, getQualityColor } from '../utils/labels';
import type { SleepSession } from '../types';
import type { Theme } from '../theme';
import type { AppStyles } from '../styles';
import { formatDuration, formatTime } from '../utils/format';

interface HistoryRowProps {
  session: SleepSession;
  T: Theme;
  styles: AppStyles;
  onPress: () => void;
}

/** 历史记录列表项：时间、时长、中断提示、四类计数徽标与质量/风险徽标 */
export function HistoryRow({ session, T, styles, onPress }: HistoryRowProps) {
  const counts = [
    { icon: 'volume-high-outline', color: T.snoreText, value: session.snoreCount },
    { icon: 'git-branch-outline', color: T.grindText, value: session.grindCount },
    { icon: 'chatbubble-outline', color: T.talkText, value: session.talkCount },
    { icon: 'pulse-outline', color: T.apneaText, value: session.apneaCount },
  ] as const;

  return (
    <TouchableOpacity style={styles.historyItem} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.historyRow}>
        <View style={styles.historyMain}>
          <Text style={styles.historyTime}>{formatTime(session.startTime)}</Text>
          <View style={styles.historyMetaRow}>
            <Ionicons name="time-outline" size={14} color={T.textTertiary} />
            <Text style={styles.historyMeta}>睡眠 {formatDuration(session.durationSeconds)}</Text>
          </View>
          {session.interrupted && (
            <View style={styles.historyMetaRow}>
              <Ionicons name="alert-circle-outline" size={14} color={T.warningText} />
              <Text style={[styles.historyMeta, { color: T.warningText }]}>
                录音中断，记录可能不完整
              </Text>
            </View>
          )}
          <View style={styles.historyCountRow}>
            {counts.map((item) => (
              <View key={item.icon} style={styles.historyCount}>
                <Ionicons name={item.icon} size={14} color={item.color} />
                <Text style={[styles.historyCountText, { color: item.color }]}>{item.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.historyRight}>
          <View style={[styles.qualityBadge, { backgroundColor: getQualityColor(session.qualityScore, T) }]}>
            <Text style={styles.qualityText}>{session.qualityScore}分</Text>
          </View>
          <View
            style={[
              styles.apneaRiskBadge,
              { backgroundColor: getApneaRiskColor(session.apneaRisk || 'low', T) },
            ]}
          >
            <Text style={styles.apneaRiskText}>{getApneaRiskLabel(session.apneaRisk || 'low')}</Text>
          </View>
        </View>

        <Ionicons
          name="chevron-forward"
          size={18}
          color={T.textTertiary}
          style={styles.historyChevron}
        />
      </View>
    </TouchableOpacity>
  );
}
