import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListJars } from '@workspace/api-client-react';
import { JarCard } from '@/components/JarCard';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { Feather } from '@expo/vector-icons';

type TabType = 'Active' | 'Invited' | 'Completed' | 'Archived';

export default function JarsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabType>('Active');

  // Map local tab state to API status parameter
  const getStatusParam = () => {
    switch (activeTab) {
      case 'Active': return 'Saving,FullyFunded';
      case 'Invited': return 'Inviting';
      case 'Completed': return 'Completed';
      case 'Archived': return 'Cancelled';
      default: return undefined;
    }
  };

  const { data: jars, isLoading, refetch, isRefetching } = useListJars({ status: getStatusParam() });

  const tabs: TabType[] = ['Active', 'Invited', 'Completed', 'Archived'];

  const renderHeader = () => (
    <View style={[styles.header, { paddingTop: insets.top + 16, backgroundColor: colors.background }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: colors.foreground }]}>My Jars</Text>
        <Pressable
          style={[styles.fab, { backgroundColor: colors.primary }]}
          onPress={() => router.push('/create-jar')}
        >
          <Feather name="plus" size={24} color={colors.primaryForeground} />
        </Pressable>
      </View>

      <View style={styles.tabsContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={tabs}
          keyExtractor={(item) => item}
          renderItem={({ item }) => (
            <Pressable
              style={[
                styles.tab,
                activeTab === item ? { backgroundColor: colors.foreground } : { backgroundColor: colors.secondary },
              ]}
              onPress={() => setActiveTab(item)}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === item ? { color: colors.background } : { color: colors.foreground },
                ]}
              >
                {item}
              </Text>
            </Pressable>
          )}
          contentContainerStyle={styles.tabsList}
        />
      </View>
    </View>
  );

  const renderEmpty = () => {
    if (isLoading) {
      return (
        <View style={styles.emptyContainer}>
          <SkeletonLoader width="100%" height={200} borderRadius={16} style={{ marginBottom: 16 }} />
          <SkeletonLoader width="100%" height={200} borderRadius={16} />
        </View>
      );
    }

    let message = "You don't have any jars in this category.";
    if (activeTab === 'Active') message = "You don't have any active jars right now.";
    else if (activeTab === 'Invited') message = "You have no pending invitations.";

    return (
      <EmptyState
        icon="archive"
        title="No Jars Found"
        description={message}
        action={activeTab === 'Active' ? {
          label: 'Create a Jar',
          onPress: () => router.push('/create-jar'),
        } : undefined}
      />
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {renderHeader()}
      <FlatList
        data={jars || []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <JarCard jar={item} />}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + 100 },
        ]}
        ListEmptyComponent={renderEmpty}
        refreshing={isRefetching}
        onRefresh={refetch}
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
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsContainer: {
    marginTop: 8,
  },
  tabsList: {
    gap: 8,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
  },
  emptyContainer: {
    marginTop: 20,
  },
});
