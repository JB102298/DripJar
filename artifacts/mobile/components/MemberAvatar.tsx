import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useColors } from '@/hooks/useColors';
import { JarMemberHealthStatus } from '@workspace/api-client-react/src/generated/api.schemas';

interface MemberAvatarProps {
  displayName: string;
  avatarUrl?: string | null;
  size?: number;
  showStatus?: boolean;
  status?: typeof JarMemberHealthStatus[keyof typeof JarMemberHealthStatus];
}

export function MemberAvatar({
  displayName,
  avatarUrl,
  size = 40,
  showStatus,
  status,
}: MemberAvatarProps) {
  const colors = useColors();

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();
  };

  let ringColor = 'transparent';
  if (showStatus && status) {
    switch (status) {
      case 'Ahead':
        ringColor = colors.success;
        break;
      case 'OnTrack':
        ringColor = '#3B82F6';
        break;
      case 'NeedsAttention':
        ringColor = colors.warning;
        break;
      case 'AtRisk':
        ringColor = colors.destructive;
        break;
      case 'NotStarted':
        ringColor = colors.mutedForeground;
        break;
    }
  }

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: showStatus ? 2 : 0,
          borderColor: ringColor,
          padding: showStatus ? 2 : 0,
        },
      ]}
    >
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: '100%', height: '100%', borderRadius: size / 2 }}
        />
      ) : (
        <View
          style={[
            styles.initialsContainer,
            { backgroundColor: colors.muted, borderRadius: size / 2 },
          ]}
        >
          <Text style={[styles.initialsText, { color: colors.primary, fontSize: size * 0.4 }]}>
            {getInitials(displayName)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  initialsContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  initialsText: {
    fontWeight: 'bold',
  },
});
