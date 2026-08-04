import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { JarHealthStatus } from '@workspace/api-client-react';

interface JarHealthBadgeProps {
  status: typeof JarHealthStatus[keyof typeof JarHealthStatus];
}

export function JarHealthBadge({ status }: JarHealthBadgeProps) {
  const colors = useColors();

  let bgColor = colors.muted;
  let textColor = colors.mutedForeground;
  let dotColor = colors.mutedForeground;
  let label = 'Unknown';

  switch (status) {
    case 'Ahead':
      bgColor = colors.secondary;
      textColor = colors.primary;
      dotColor = colors.success;
      label = 'Ahead of Schedule';
      break;
    case 'OnTrack':
      bgColor = colors.secondary;
      textColor = colors.primary;
      dotColor = '#3B82F6'; // Blue
      label = 'On Track';
      break;
    case 'NeedsAttention':
      bgColor = '#FEF3C7';
      textColor = '#92400E';
      dotColor = colors.warning;
      label = 'Needs Attention';
      break;
    case 'AtRisk':
      bgColor = '#FEE2E2';
      textColor = '#991B1B';
      dotColor = colors.destructive;
      label = 'At Risk';
      break;
  }

  return (
    <View style={[styles.badge, { backgroundColor: bgColor }]}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={[styles.text, { color: textColor }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
});
