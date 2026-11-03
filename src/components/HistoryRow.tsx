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
  return (
    <TouchableOpacity style={styles.historyItem} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.historyRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.historyTime}>{formatTime(session.startTime)}</Text>
          <View style={styles.historyMetaRow}>
            <Ionicons name="time-outline" size={14} color={T.textTertiary} />
            <Text style={styles.historyMeta}>睡眠 {formatDuration(session.durationSeconds)}</Text>
          </View>
          {session.interrupted && (
            <View style={styles.historyMetaRow}>
              <Ionicons name="alert-circle-outline" size={14} color={T.warning} />
              <Text style={[styles.historyMeta, { color: T.warning }]}>录音中断，记录可能不完整</Text>
            </View>
          )}
          <View style={styles.historyCountRow}>
            <View style={[styles.historyCount, { backgroundColor: `${T.snore}15` }]}>
              <Ionicons name="volume-high-outline" size={14} color={T.snore} />
              <Text style={[styles.historyCountText, { color: T.snore }]}>{session.snoreCount}</Text>
            </View>
            <View style={[styles.historyCount, { backgroundColor: `${T.grind}15` }]}>
              <Ionicons name="git-branch-outline" size={14} color={T.grind} />
              <Text style={[styles.historyCountText, { color: T.grind }]}>{session.grindCount}</Text>
            </View>
            <View style={[styles.historyCount, { backgroundColor: `${T.talk}15` }]}>
              <Ionicons name="chatbubble-outline" size={14} color={T.talk} />
              <Text style={[styles.historyCountText, { color: T.talk }]}>{session.talkCount}</Text>
            </View>
            <View style={[styles.historyCount, { backgroundColor: `${T.apnea}15` }]}>
              <Ionicons name="pulse-outline" size={14} color={T.apnea} />
              <Text style={[styles.historyCountText, { color: T.apnea }]}>{session.apneaCount}</Text>
            </View>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <View style={[styles.qualityBadge, { backgroundColor: getQualityColor(session.qualityScore, T) }]}>
            <Text style={styles.qualityText}>{session.qualityScore}分</Text>
          </View>
          <View
            style={[
              styles.apneaRiskBadge,
              { backgroundColor: getApneaRiskColor(session.apneaRisk || 'low', T), marginTop: 6 },
            ]}
          >
            <Text style={styles.apneaRiskText}>{getApneaRiskLabel(session.apneaRisk || 'low')}</Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={20} color={T.textTertiary} style={{ marginLeft: 8 }} />
      </View>
    </TouchableOpacity>
  );
}
