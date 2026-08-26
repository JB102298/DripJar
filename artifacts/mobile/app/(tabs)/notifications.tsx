/**
 * Notifications.
 *
 * Renders the server's `title`, `message`, `type`, and `createdAt` and nothing
 * else. No amount, percentage, progress figure, or milestone state is computed
 * here — those are settled against the ledger before the notification row is
 * written (see api-server/src/lib/notification-financial.ts), and recomputing
 * any of them on the client is exactly how the two-sources-of-truth defect got
 * in. There is no sample, seeded, or locally synthesised notification in this
 * file; an account with no rows renders the empty state.
 *
 * Icons and destinations come from lib/notification-presentation.ts; the paged
 * data, the unread total, and the optimistic read behaviour come from
 * hooks/useNotificationFeed.ts. This file is presentation.
 */

import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { useNotificationFeed } from '@/hooks/useNotificationFeed';
import {
  formatNotificationTimestamp,
  notificationAccessibilityHint,
  notificationAccessibilityLabel,
  notificationHref,
  notificationIcon,
  resolveNotificationDestination,
} from '@/lib/notification-presentation';
import type { Notification } from '@workspace/api-client-react';

export default function NotificationsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    notifications,
    unreadCount,
    isLoading,
    isError,
    isRefreshing,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    markRead,
    markAllRead,
    isMarkingAllRead,
  } = useNotificationFeed();

  // Returning to the tab re-reads both the page and the unread total, so a
  // notification generated while the user was elsewhere appears without a
  // manual pull. Opening the screen does NOT mark anything read — reading the
  // list and reading a notification are different acts.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const handlePress = useCallback(
    (item: Notification) => {
      // Read state is settled first and unconditionally. A destination that does
      // not exist is not a reason to leave a tapped row unread.
      markRead(item.id);

      const href = notificationHref(resolveNotificationDestination(item));
      // No safe existing destination for this type: stay on the list rather
      // than inventing a route.
      if (href) router.push(href as never);
    },
    [markRead, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: Notification }) => {
      const unread = !item.isRead;
      const destination = resolveNotificationDestination(item);

      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={notificationAccessibilityLabel({
            title: item.title,
            message: item.message,
            isRead: item.isRead,
          })}
          accessibilityHint={notificationAccessibilityHint(destination)}
          testID={`notification-${item.id}`}
          onPress={() => handlePress(item)}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: colors.border, backgroundColor: colors.background },
            unread && { backgroundColor: colors.secondary },
            pressed && { opacity: 0.7 },
          ]}
        >
          {/* Unread is carried by three independent signals — this accent bar,
              the heavier title, and the "New" pill — so the distinction does not
              depend on the background tint alone. */}
          <View
            style={[
              styles.accent,
              { backgroundColor: unread ? colors.primary : 'transparent' },
            ]}
          />

          <View style={[styles.iconContainer, { backgroundColor: colors.card }]}>
            <Feather
              name={notificationIcon(item.type) as never}
              size={20}
              color={unread ? colors.primary : colors.mutedForeground}
            />
          </View>

          <View style={styles.content}>
            <View style={styles.titleRow}>
              <Text
                style={[
                  styles.title,
                  { color: colors.foreground, fontWeight: unread ? '700' : '500' },
                ]}
              >
                {item.title}
              </Text>
              {unread && (
                <View style={[styles.newPill, { backgroundColor: colors.primary }]}>
                  <Text style={[styles.newPillText, { color: colors.primaryForeground }]}>New</Text>
                </View>
              )}
            </View>
            <Text style={[styles.message, { color: colors.mutedForeground }]}>{item.message}</Text>
            <Text style={[styles.time, { color: colors.mutedForeground }]}>
              {formatNotificationTimestamp(item.createdAt)}
            </Text>
          </View>
        </Pressable>
      );
    },
    [colors, handlePress],
  );

  const header = (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Text style={[styles.headerTitle, { color: colors.foreground }]}>Notifications</Text>
      {/* Offered only when there is something to mark. A permanently visible
          control on an all-read list is a button that does nothing. */}
      {unreadCount > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Mark all as read"
          testID="mark-all-read"
          disabled={isMarkingAllRead}
          onPress={markAllRead}
          style={({ pressed }) => [styles.markAll, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.markAllText, { color: colors.primary }]}>Mark all as read</Text>
        </Pressable>
      )}
    </View>
  );

  // Loading, error, empty, and populated are four distinct renders. Collapsing
  // error into empty is what tells an account whose request failed that it has
  // nothing — the defect already fixed on Home and My Jars.
  const listEmptyComponent = isLoading ? (
    <View testID="notifications-loading" style={styles.skeletons}>
      <SkeletonLoader height={80} />
      <SkeletonLoader height={80} />
      <SkeletonLoader height={80} />
    </View>
  ) : isError ? (
    <View testID="notifications-error">
      <EmptyState
        icon="alert-circle"
        title="We couldn't load your notifications"
        description="Check your connection and try again."
        action={{ label: 'Try again', onPress: () => void refresh() }}
      />
    </View>
  ) : (
    <View testID="notifications-empty">
      <EmptyState
        icon="bell"
        title="You're all caught up"
        description="We'll notify you when there's activity in your jars."
      />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {header}

      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 100 }]}
        refreshing={isRefreshing}
        onRefresh={refresh}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={listEmptyComponent}
        ListFooterComponent={
          isLoadingMore ? (
            <View testID="notifications-loading-more" style={styles.footer}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : hasMore ? (
            <View style={styles.footer} />
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 32, fontWeight: 'bold' },
  markAll: { paddingVertical: 6, paddingHorizontal: 4 },
  markAllText: { fontSize: 14, fontWeight: '600' },
  listContent: { flexGrow: 1 },
  row: { flexDirection: 'row', padding: 16, borderBottomWidth: 1, alignItems: 'flex-start' },
  accent: { width: 3, alignSelf: 'stretch', borderRadius: 2, marginRight: 13 },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
    ...Platform.select({
      web: {},
      default: {
        shadowColor: '#000',
        shadowOpacity: 0.05,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 4,
        elevation: 2,
      },
    }),
  },
  content: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  title: { fontSize: 16, flexShrink: 1 },
  newPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  newPillText: { fontSize: 11, fontWeight: '700' },
  message: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  time: { fontSize: 12 },
  skeletons: { padding: 16, gap: 16 },
  footer: { paddingVertical: 24 },
});
