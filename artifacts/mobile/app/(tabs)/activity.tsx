import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListJarActivity, getListJarActivityQueryKey } from '@workspace/api-client-react';
import { MemberAvatar } from '@/components/MemberAvatar';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import type { ActivityEvent } from '@workspace/api-client-react';
import { Feather } from '@expo/vector-icons';

export default function ActivityScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Global activity tab has no jarId context — query disabled, shows empty state
  const { data: activityItems, isLoading, refetch, isRefetching } = useListJarActivity(
    '',
    undefined,
    { query: { queryKey: getListJarActivityQueryKey(''), enabled: false } },
  );

  const getRelativeTime = (dateStr: string) => {
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const date = new Date(dateStr);
    const now = new Date();
    const diffHours = (date.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (Math.abs(diffHours) < 1) {
      const diffMins = Math.round(diffHours * 60);
      return rtf.format(diffMins, 'minute');
    }
    if (Math.abs(diffHours) < 24) {
      return rtf.format(Math.round(diffHours), 'hour');
    }
    const diffDays = Math.round(diffHours / 24);
    return rtf.format(diffDays, 'day');
  };

  const renderItem = ({ item }: { item: ActivityEvent }) => {
    const isContribution = item.eventType === 'contribution_added';
    
    return (
      <View style={[styles.activityItem, { borderBottomColor: colors.border }]}>
        <View style={styles.avatarContainer}>
          {item.actorName ? (
            <MemberAvatar displayName={item.actorName} avatarUrl={item.actorAvatarUrl} size={40} />
          ) : (
            <View style={[styles.systemAvatar, { backgroundColor: colors.secondary }]}>
              <Feather name="bell" size={20} color={colors.primary} />
            </View>
          )}
        </View>
        <View style={styles.activityContent}>
          {/* The actor is rendered separately rather than prefixed into the
              description. Descriptions are written once and never updated, so
              a name inside one is frozen at write time; `actorName` is
              resolved on every read and follows renames. Null for genuine
              system events, which then show the description alone. */}
          {item.actorName ? (
            <Text style={[styles.actorName, { color: colors.foreground }]} numberOfLines={1}>
              {item.actorName}
            </Text>
          ) : null}
          <Text style={[styles.description, { color: colors.mutedForeground }]}>
            {item.description}
          </Text>
          <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
            {getRelativeTime(item.createdAt)}
          </Text>
        </View>
        {isContribution && item.amountCents ? (
          <View style={[styles.amountChip, { backgroundColor: colors.lightGreen }]}>
            <Text style={[styles.amountText, { color: colors.darkGreen }]}>
              +${(item.amountCents / 100).toLocaleString()}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>Activity</Text>
      </View>

      <FlatList
        data={activityItems || []}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 100 }]}
        refreshing={isRefetching}
        onRefresh={refetch}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.skeletonContainer}>
              <SkeletonLoader height={60} style={{ marginBottom: 16 }} />
              <SkeletonLoader height={60} style={{ marginBottom: 16 }} />
              <SkeletonLoader height={60} />
            </View>
          ) : (
            <EmptyState
              icon="activity"
              title="No recent activity"
              description="When members contribute or jars are updated, you'll see it here."
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
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  listContent: {
    flexGrow: 1,
  },
  activityItem: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  avatarContainer: {
    marginRight: 12,
  },
  systemAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityContent: {
    flex: 1,
    marginRight: 12,
  },
  actorName: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  description: {
    fontSize: 15,
    lineHeight: 20,
    marginBottom: 4,
  },
  timeText: {
    fontSize: 13,
  },
  amountChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  amountText: {
    fontWeight: 'bold',
    fontSize: 14,
  },
  skeletonContainer: {
    padding: 16,
  },
});
