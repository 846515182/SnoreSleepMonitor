import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AppStyles } from '../styles';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface SettingHeaderProps {
  icon: IconName;
  color: string;
  title: string;
  styles: AppStyles;
  marginTop?: number;
}

export function SettingHeader({ icon, color, title, styles, marginTop = 0 }: SettingHeaderProps) {
  return (
    <View style={[styles.settingHeader, marginTop !== 0 && { marginTop }]}>
      <View style={[styles.settingIconCircle, { backgroundColor: `${color}20` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

interface SettingSectionProps extends SettingHeaderProps {
  description?: React.ReactNode;
  children?: React.ReactNode;
}

export function SettingSection({ description, children, ...header }: SettingSectionProps) {
  return (
    <View style={header.styles.settingSection}>
      <SettingHeader {...header} />
      {description ? <Text style={header.styles.settingsDesc}>{description}</Text> : null}
      {children}
    </View>
  );
}
