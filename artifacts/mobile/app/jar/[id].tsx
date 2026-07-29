import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { 
  useGetJar, 
  useGetJarHealth,
  useListJarMembers,
  useListMilestones,
  useListJarActivity,
  useListAgreements
} from '@workspace/api-client-react';
import { ImageBackground } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { CircularProgress } from '@/components/CircularProgress';
import { JarHealthBadge } from '@/components/JarHealthBadge';
import { ProgressBar } from '@/components/ProgressBar';
import { MemberAvatar } from '@/components/MemberAvatar';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/auth-context';

type Tab = 'Overview' | 'Members' | 'Milestones' | 'Activity' | 'Agreements' | 'Settings';
const TABS: Tab[] = ['Overview', 'Members', 'Milestones', 'Activity', 'Agreements', 'Settings'];

export default function JarDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [refreshing, setRefreshing] = useState(false);

  const { data: jar, isLoading: jarLoading, refetch: refetchJar } = useGetJar(id!, { query: { enabled: !!id } });
  const { data: health, refetch: refetchHealth } = useGetJarHealth(id!, { query: { enabled: !!id } });
  const { data: members, refetch: refetchMembers } = useListJarMembers(id!, { query: { enabled: !!id && activeTab === 'Members' } });
  const { data: milestones, refetch: refetchMilestones } = useListMilestones(id!, { query: { enabled: !!id && activeTab === 'Milestones' } });
  const { data: activity, refetch: refetchActivity } = useListJarActivity(id!, undefined, { query: { enabled: !!id && activeTab === 'Activity' } });
  const { data: agreements, refetch: refetchAgreements } = useListAgreements(id!, { query: { enabled: !!id && activeTab === 'Agreements' } });

  const onRefresh = async () => {
    setRefreshing(true);
    await refetchJar();
    await refetchHealth();
    if (activeTab === 'Members') await refetchMembers();
    if (activeTab === 'Milestones') await refetchMilestones();
    if (activeTab === 'Activity') await refetchActivity();
    if (activeTab === 'Agreements') await refetchAgreements();
    setRefreshing(false);
  };

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const renderOverview = () => {
    if (!jar) return null;
    return (
      <View style={styles.tabContent}>
        <View style={styles.overviewTopRow}>
          <CircularProgress 
            size={120} 
            progress={jar.percentFunded} 
            strokeWidth={12} 
            color={colors.primary} 
            trackColor={colors.muted}
          >
            <Text style={[styles.centerPercent, { color: colors.foreground }]}>{jar.percentFunded}%</Text>
            <Text style={[styles.centerSub, { color: colors.mutedForeground }]}>funded</Text>
          </CircularProgress>

          <View style={styles.overviewStats}>
            <Text style={[styles.overviewAmount, { color: colors.foreground }]}>
              {formatCurrency(jar.totalSavedCents)}
            </Text>
            <Text style={[styles.overviewTarget, { color: colors.mutedForeground }]}>
              of {formatCurrency(jar.goalAmountCents)}
            </Text>
            {jar.daysRemaining !== null && jar.daysRemaining !== undefined && (
              <View style={[styles.daysLeftChip, { backgroundColor: colors.secondary }]}>
                <Text style={[styles.daysLeftText, { color: colors.primary }]}>{jar.daysRemaining} days left</Text>
              </View>
            )}
          </View>
        </View>

        {health && (
          <View style={[styles.healthCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <JarHealthBadge status={health.status} />
            <Text style={[styles.healthMessage, { color: colors.foreground }]}>{health.message}</Text>
          </View>
        )}

        <View style={[styles.actionRow, { marginTop: 24 }]}>
          <Pressable 
            style={[styles.actionButton, { backgroundColor: colors.primary }]}
            onPress={() => router.push(`/contribution/${jar.id}`)}
          >
            <Feather name="plus" size={20} color={colors.primaryForeground} />
            <Text style={[styles.actionButtonText, { color: colors.primaryForeground }]}>Add Funds</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderMembers = () => {
    if (!members) return <SkeletonLoader height={200} />;
    return (
      <View style={styles.tabContent}>
        {members.map(member => (
          <View key={member.id} style={[styles.memberRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <MemberAvatar 
              displayName={member.profile?.displayName || 'Unknown'} 
              avatarUrl={member.profile?.avatarUrl} 
              size={48} 
              showStatus
              status={member.healthStatus}
            />
            <View style={styles.memberInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <Text style={[styles.memberName, { color: colors.foreground }]}>{member.profile?.displayName}</Text>
                {member.role === 'organizer' && (
                  <View style={[styles.roleChip, { backgroundColor: '#FEF3C7' }]}>
                    <Feather name="award" size={12} color="#92400E" />
                    <Text style={[styles.roleText, { color: '#92400E' }]}>Organizer</Text>
                  </View>
                )}
              </View>
              <ProgressBar progress={member.percentComplete} height={6} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={[styles.memberAmount, { color: colors.mutedForeground }]}>
                  {formatCurrency(member.contributedAmountCents)} / {formatCurrency(member.contributionTargetCents)}
                </Text>
                <Text style={[styles.memberPercent, { color: colors.primary }]}>{member.percentComplete}%</Text>
              </View>
            </View>
          </View>
        ))}
        {members.length === 0 && <EmptyState icon="users" title="No members yet" />}
      </View>
    );
  };

  const renderMilestones = () => {
    if (!milestones) return <SkeletonLoader height={200} />;
    return (
      <View style={styles.tabContent}>
        {milestones.map(milestone => (
          <View key={milestone.id} style={[styles.milestoneCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.milestoneHeader}>
              <Text style={[styles.milestoneName, { color: colors.foreground }]}>{milestone.name}</Text>
              <View style={[styles.statusChip, { backgroundColor: milestone.status === 'funded' ? colors.success : colors.muted }]}>
                <Text style={[styles.statusText, { color: milestone.status === 'funded' ? '#fff' : colors.foreground }]}>
                  {milestone.status.toUpperCase()}
                </Text>
              </View>
            </View>
            <ProgressBar progress={milestone.percentFunded} height={8} />
            <View style={styles.milestoneFooter}>
              <Text style={[styles.milestoneAmount, { color: colors.mutedForeground }]}>
                {formatCurrency(milestone.allocatedAmountCents)} of {formatCurrency(milestone.targetAmountCents)}
              </Text>
              {milestone.dueDate && (
                <Text style={[styles.milestoneDate, { color: colors.mutedForeground }]}>
                  Due: {new Date(milestone.dueDate).toLocaleDateString()}
                </Text>
              )}
            </View>
          </View>
        ))}
        {milestones.length === 0 && <EmptyState icon="target" title="No milestones yet" />}
      </View>
    );
  };

  const renderActivity = () => {
    if (!activity) return <SkeletonLoader height={200} />;
    return (
      <View style={styles.tabContent}>
        {activity.map(item => (
          <View key={item.id} style={[styles.activityItem, { borderBottomColor: colors.border }]}>
             <View style={styles.activityIcon}>
               {item.actorAvatarUrl || item.actorName ? (
                 <MemberAvatar displayName={item.actorName || ''} avatarUrl={item.actorAvatarUrl} size={32} />
               ) : (
                 <View style={[styles.systemAvatar, { backgroundColor: colors.muted }]}>
                   <Feather name="bell" size={16} color={colors.foreground} />
                 </View>
               )}
             </View>
             <View style={styles.activityContent}>
               <Text style={[styles.activityDesc, { color: colors.foreground }]}>{item.description}</Text>
               <Text style={[styles.activityTime, { color: colors.mutedForeground }]}>
                 {new Date(item.createdAt).toLocaleDateString()}
               </Text>
             </View>
          </View>
        ))}
        {activity.length === 0 && <EmptyState icon="activity" title="No activity yet" />}
      </View>
    );
  };

  const renderAgreements = () => {
    if (!agreements || agreements.length === 0) return (
      <View style={styles.tabContent}>
        <EmptyState icon="file-text" title="No agreements" />
      </View>
    );
    const agreement = agreements[0]; // Just show the latest
    return (
      <View style={styles.tabContent}>
        <View style={[styles.agreementCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.agreementContent, { color: colors.foreground }]}>{agreement.content}</Text>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Text style={[styles.agreementStatus, { color: agreement.myAcceptance ? colors.success : colors.warning }]}>
            {agreement.myAcceptance ? "You have accepted this agreement." : "You have not accepted this agreement yet."}
          </Text>
        </View>
      </View>
    );
  };

  const renderSettings = () => {
    return (
      <View style={styles.tabContent}>
        <Text style={{ color: colors.foreground, fontSize: 16 }}>Settings coming soon</Text>
      </View>
    );
  };

  if (jarLoading && !jar) {
    return <SkeletonLoader height="100%" />;
  }

  if (!jar) return <EmptyState icon="alert-circle" title="Jar not found" />;

  const isOrganizer = jar.organizerId === user?.id; // This might be available on members list instead

  const imageSource = jar.coverImageUrl
    ? { uri: jar.coverImageUrl }
    : require('../../assets/images/hawaii-cover.jpg');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.headerImageContainer, { height: insets.top + 160 }]}>
        <ImageBackground source={imageSource} style={StyleSheet.absoluteFill} contentFit="cover">
          <LinearGradient colors={['rgba(0,0,0,0.4)', 'rgba(0,0,0,0.8)']} style={StyleSheet.absoluteFill} />
          <View style={[styles.headerContent, { paddingTop: insets.top }]}>
            <View style={styles.navRow}>
              <Pressable onPress={() => router.back()} style={styles.backButton}>
                <Feather name="arrow-left" size={24} color="#fff" />
              </Pressable>
              <Pressable style={styles.shareButton}>
                <Feather name="share" size={24} color="#fff" />
              </Pressable>
            </View>
            <View style={styles.titleArea}>
              <Text style={styles.headerTitle}>{jar.name}</Text>
              {jar.destination && (
                <Text style={styles.headerSubtitle}><Feather name="map-pin" size={14} /> {jar.destination}</Text>
              )}
            </View>
          </View>
        </ImageBackground>
      </View>

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBarScroll}>
          {TABS.map(tab => {
            if (tab === 'Settings' && !isOrganizer) return null; // Simple check
            const isActive = activeTab === tab;
            return (
              <Pressable 
                key={tab} 
                onPress={() => setActiveTab(tab)}
                style={[styles.tabButton, isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
              >
                <Text style={[styles.tabText, { color: isActive ? colors.primary : colors.mutedForeground, fontWeight: isActive ? '600' : '400' }]}>
                  {tab}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView 
        style={styles.mainScroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {activeTab === 'Overview' && renderOverview()}
        {activeTab === 'Members' && renderMembers()}
        {activeTab === 'Milestones' && renderMilestones()}
        {activeTab === 'Activity' && renderActivity()}
        {activeTab === 'Agreements' && renderAgreements()}
        {activeTab === 'Settings' && renderSettings()}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerImageContainer: {
    width: '100%',
  },
  headerContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
    justifyContent: 'space-between',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  backButton: { padding: 8, marginLeft: -8 },
  shareButton: { padding: 8, marginRight: -8 },
  titleArea: {
    justifyContent: 'flex-end',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  headerSubtitle: {
    color: '#E8F6EF',
    fontSize: 16,
    fontWeight: '500',
  },
  tabBar: {
    borderBottomWidth: 1,
  },
  tabBarScroll: {
    paddingHorizontal: 8,
  },
  tabButton: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  tabText: {
    fontSize: 15,
  },
  mainScroll: {
    flex: 1,
  },
  tabContent: {
    padding: 16,
  },
  overviewTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  centerPercent: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  centerSub: {
    fontSize: 12,
  },
  overviewStats: {
    flex: 1,
    marginLeft: 24,
  },
  overviewAmount: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  overviewTarget: {
    fontSize: 16,
    marginBottom: 12,
  },
  daysLeftChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  daysLeftText: {
    fontWeight: 'bold',
    fontSize: 14,
  },
  healthCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  healthMessage: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  memberRow: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    alignItems: 'center',
  },
  memberInfo: {
    flex: 1,
    marginLeft: 16,
  },
  memberName: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  roleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
    gap: 4,
  },
  roleText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  memberAmount: {
    fontSize: 13,
  },
  memberPercent: {
    fontSize: 13,
    fontWeight: 'bold',
  },
  milestoneCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
  },
  milestoneHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  milestoneName: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  milestoneFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  milestoneAmount: {
    fontSize: 14,
    fontWeight: '500',
  },
  milestoneDate: {
    fontSize: 14,
  },
  activityItem: {
    flexDirection: 'row',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  activityIcon: {
    marginRight: 12,
  },
  systemAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityContent: {
    flex: 1,
  },
  activityDesc: {
    fontSize: 14,
    marginBottom: 4,
    lineHeight: 20,
  },
  activityTime: {
    fontSize: 12,
  },
  agreementCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  agreementContent: {
    fontSize: 15,
    lineHeight: 24,
  },
  divider: {
    height: 1,
    marginVertical: 16,
  },
  agreementStatus: {
    fontSize: 14,
    fontWeight: '600',
  },
});
