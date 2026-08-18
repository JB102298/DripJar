import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useListJars,
  getListJarsQueryKey,
  useListMyInvitations,
  getListMyInvitationsQueryKey,
} from '@workspace/api-client-react';
import { JarCard } from '@/components/JarCard';
import { InvitationCard } from '@/components/InvitationCard';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { Feather } from '@expo/vector-icons';
import { JAR_TABS, statusParamForTab, pendingInvitations, type JarTab } from '@/lib/jar-status';

export default function JarsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<JarTab>('Active');

  const isInvitedTab = activeTab === 'Invited';
  const statusParam = statusParamForTab(activeTab);

  // Two sources, one list. The lifecycle tabs read GET /jars; Invited reads
  // GET /invitations, because an invitation you have not accepted yet is
  // membership state and GET /jars only returns jars you already belong to.
  // Each query is disabled on the other tab's turn so switching tabs does not
  // fire a request whose result can never be shown.
  const jarsQuery = useListJars(
    { status: statusParam },
    {
      query: {
        queryKey: getListJarsQueryKey({ status: statusParam }),
        enabled: !isInvitedTab,
      },
    },
  );
  const invitationsQuery = useListMyInvitations({
    query: {
      queryKey: getListMyInvitationsQueryKey(),
      enabled: isInvitedTab,
    },
  });

  const activeQuery = isInvitedTab ? invitationsQuery : jarsQuery;
  const { isLoading, refetch, isRefetching } = activeQuery;

  const jars = jarsQuery.data;
  const invitations = pendingInvitations(invitationsQuery.data);

  const tabs = JAR_TABS;

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

    // A failed request must not read as an empty account. Owner QA item 10 was
    // exactly this: the Active tab said "you have no active jars" while the
    // user had one, because the request came back empty rather than erroring.
    if (activeQuery.isError) {
      return (
        <EmptyState
          icon="alert-circle"
          title="Couldn't load your jars"
          description="Something went wrong reaching DripJar. Pull down to try again."
        />
      );
    }

    if (isInvitedTab) {
      return (
        <EmptyState
          icon="mail"
          title="No invitations"
          description="When someone invites you to a jar, it will show up here."
        />
      );
    }

    const message = activeTab === 'Active'
      ? "You don't have any active jars right now."
      : activeTab === 'Completed'
        ? "You haven't completed any jars yet."
        : "You don't have any archived jars.";

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
      {isInvitedTab ? (
        <FlatList
          data={invitations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <InvitationCard invitation={item} />}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + 100 },
          ]}
          ListEmptyComponent={renderEmpty}
          refreshing={isRefetching}
          onRefresh={refetch}
        />
      ) : (
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
      )}
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
