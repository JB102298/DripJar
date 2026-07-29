import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListNotifications } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { Feather } from '@expo/vector-icons';
import type { Notification } from '@workspace/api-client-react/src/generated/api.schemas';

export default function NotificationsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { data: notifications, isLoading, refetch, isRefetching } = useListNotifications();

  // Mock mark as read (actual API might have a mutation for this)
  const markAsRead = (id: string) => {
    // API call would go here
  };

  const getIconForType = (type: string) => {
    switch (type) {
      case 'contribution_recorded': return 'dollar-sign';
      case 'invitation_received': return 'mail';
      case 'member_joined': return 'user-plus';
      case 'goal_fully_funded': return 'check-circle';
      case 'jar_halfway_funded': return 'trending-up';
      default: return 'bell';
    }
  };

  const renderItem = ({ item }: { item: Notification }) => {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.notificationItem,
          { borderBottomColor: colors.border },
          !item.isRead && { backgroundColor: colors.secondary },
          pressed && { opacity: 0.7 },
        ]}
        onPress={() => {
          if (!item.isRead) markAsRead(item.id);
          if (item.relatedJarId) {
            router.push(`/jar/${item.relatedJarId}`);
          } else if (item.actionUrl) {
            // handle other URLs if needed
          }
        }}
      >
        <View style={[styles.iconContainer, { backgroundColor: item.isRead ? colors.card : colors.background }]}>
          <Feather name={getIconForType(item.type)} size={20} color={colors.primary} />
        </View>
        <View style={styles.content}>
          <Text style={[styles.title, { color: colors.foreground }]}>{item.title}</Text>
          <Text style={[styles.message, { color: colors.mutedForeground }]}>{item.message}</Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {new Date(item.createdAt).toLocaleDateString()}
          </Text>
        </View>
        {!item.isRead && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Notifications</Text>
      </View>

      <FlatList
        data={notifications || []}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 100 }]}
        refreshing={isRefetching}
        onRefresh={refetch}
        ListEmptyComponent={
          isLoading ? (
            <View style={{ padding: 16, gap: 16 }}>
              <SkeletonLoader height={80} />
              <SkeletonLoader height={80} />
            </View>
          ) : (
            <EmptyState
              icon="bell"
              title="You're all caught up"
              description="We'll notify you when there's activity in your jars."
            />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  listContent: {
    flexGrow: 1,
  },
  notificationItem: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  time: {
    fontSize: 12,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 8,
    marginTop: 8,
  },
});
