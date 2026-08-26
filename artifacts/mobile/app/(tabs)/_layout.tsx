import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import {
  useGetUnreadNotificationCount,
  getGetUnreadNotificationCountQueryKey,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { formatBadgeCount } from '@/lib/notification-presentation';

export default function TabLayout() {
  const colors = useColors();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';
  const { isAuthenticated } = useAuth();

  // The caller's true unread total, straight from the server.
  //
  // This used to be `notifications.filter(n => !n.isRead).length` over the
  // notification LIST — the count of unread rows in one page, capped by the
  // page size and reading 0 whenever the loaded page happened to be fully read.
  // The badge is not a property of a page, so it no longer reads one. Loading
  // more notifications cannot change this number.
  //
  // Gated on `isAuthenticated`, and the query cache is cleared on login and
  // logout (contexts/auth-context.tsx), so a signed-out or newly switched
  // account cannot render the previous user's count.
  const { data: unread } = useGetUnreadNotificationCount({
    query: { queryKey: getGetUnreadNotificationCountQueryKey(), enabled: isAuthenticated },
  });

  // undefined at zero — the badge is not rendered at all rather than rendered
  // showing "0". Above 99 it reads "99+".
  const badge = isAuthenticated ? formatBadgeCount(unread?.unreadCount) : undefined;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint="light"
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Feather name="home" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="jars"
        options={{
          title: 'Jars',
          tabBarIcon: ({ color }) => <Feather name="archive" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color }) => <Feather name="activity" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color }) => <Feather name="bell" size={24} color={color} />,
          tabBarBadge: badge,
          tabBarBadgeStyle: { backgroundColor: colors.destructive },
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <Feather name="user" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
