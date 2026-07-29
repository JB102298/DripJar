import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGetDashboard } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { MemberAvatar } from '@/components/MemberAvatar';
import { ProgressBar } from '@/components/ProgressBar';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonLoader } from '@/components/SkeletonLoader';
import { CircularProgress } from '@/components/CircularProgress';
import { Feather } from '@expo/vector-icons';
import { ImageBackground } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { JarHealthBadge } from '@/components/JarHealthBadge';
import * as Haptics from 'expo-haptics';

export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const { data: dashboard, isLoading, refetch } = useGetDashboard();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const getTimeOfDay = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const getTodayDate = () => {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  };

  const renderSkeleton = () => (
    <View style={[styles.container, { paddingTop: insets.top + 20, paddingHorizontal: 16 }]}>
      <SkeletonLoader width={200} height={32} style={{ marginBottom: 8 }} />
      <SkeletonLoader width={150} height={20} style={{ marginBottom: 32 }} />
      <SkeletonLoader width="100%" height={240} borderRadius={16} style={{ marginBottom: 24 }} />
      <SkeletonLoader width="100%" height={120} borderRadius={16} />
    </View>
  );

  if (isLoading && !dashboard) {
    return renderSkeleton();
  }

  const hasJars = dashboard && dashboard.totalJars > 0;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.contentContainer,
        { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 80 },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.header}>
        <Text style={[styles.greeting, { color: colors.foreground }]}>
          {getTimeOfDay()}, {profile?.firstName || 'Traveler'}!
        </Text>
        <Text style={[styles.dateText, { color: colors.mutedForeground }]}>{getTodayDate()}</Text>
      </View>

      {!hasJars ? (
        <EmptyState
          icon="archive"
          title="You don't have any Jars yet"
          description="Create your first goal and start saving together."
          action={{
            label: 'Create a Jar',
            onPress: () => router.push('/create-jar'),
          }}
        />
      ) : (
        <>
          {dashboard?.featuredJar && (
            <Pressable
              onPress={() => router.push(`/jar/${dashboard.featuredJar!.id}`)}
              style={({ pressed }) => [
                styles.heroCard,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { opacity: 0.95, transform: [{ scale: 0.98 }] },
              ]}
            >
              <ImageBackground
                source={
                  dashboard.featuredJar.coverImageUrl
                    ? { uri: dashboard.featuredJar.coverImageUrl }
                    : require('../../assets/images/hawaii-cover.jpg')
                }
                style={styles.heroImage}
              >
                <LinearGradient colors={['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.8)']} style={StyleSheet.absoluteFill} />
                <View style={styles.heroContent}>
                  <View style={styles.heroTopRow}>
                    <View>
                      <Text style={styles.heroJarName}>{dashboard.featuredJar.name}</Text>
                      {dashboard.featuredJar.destination && (
                        <Text style={styles.heroDestination}>{dashboard.featuredJar.destination}</Text>
                      )}
                    </View>
                    {dashboard.featuredJar.daysRemaining !== null && dashboard.featuredJar.daysRemaining !== undefined && (
                      <View style={styles.daysChip}>
                        <Text style={styles.daysText}>{dashboard.featuredJar.daysRemaining} days left</Text>
                      </View>
                    )}
                  </View>

                  <View style={styles.heroBottomRow}>
                    <CircularProgress size={80} progress={dashboard.featuredJar.percentFunded} strokeWidth={8} color={colors.primary} trackColor="rgba(255,255,255,0.2)">
                      <Text style={styles.heroPercentText}>{dashboard.featuredJar.percentFunded}%</Text>
                    </CircularProgress>
                    <View style={styles.heroStats}>
                      <Text style={styles.heroAmountText}>
                        <Text style={{ fontWeight: 'bold', color: '#fff' }}>{formatCurrency(dashboard.featuredJar.totalSavedCents)}</Text>
                        <Text style={{ color: 'rgba(255,255,255,0.7)' }}> of {formatCurrency(dashboard.featuredJar.goalAmountCents)} saved</Text>
                      </Text>
                      {dashboard.featuredJar.health && (
                        <View style={{ marginTop: 8 }}>
                          <JarHealthBadge status={dashboard.featuredJar.health.status} />
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              </ImageBackground>
            </Pressable>
          )}

          {dashboard?.personalProgress && (
            <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Your Contribution</Text>
              <ProgressBar progress={dashboard.personalProgress.percentComplete} height={8} />
              <View style={styles.progressRow}>
                <Text style={[styles.progressText, { color: colors.mutedForeground }]}>
                  Contributed: {formatCurrency(dashboard.personalProgress.contributedAmountCents)} / {formatCurrency(dashboard.personalProgress.targetAmountCents)}
                </Text>
                <Text style={[styles.progressText, { color: colors.foreground, fontWeight: '600' }]}>
                  Remaining: {formatCurrency(dashboard.personalProgress.remainingAmountCents)}
                </Text>
              </View>
              {dashboard.personalProgress.nextScheduledDate && (
                <View style={[styles.scheduledInfo, { backgroundColor: colors.secondary }]}>
                  <Feather name="calendar" size={14} color={colors.primary} />
                  <Text style={[styles.scheduledText, { color: colors.secondaryForeground }]}>
                    Next: {formatCurrency(dashboard.personalProgress.nextScheduledAmountCents || 0)} on {new Date(dashboard.personalProgress.nextScheduledDate).toLocaleDateString()}
                  </Text>
                </View>
              )}
            </View>
          )}

          {dashboard?.memberProgress && dashboard.memberProgress.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionHeaderTitle, { color: colors.foreground }]}>Group Progress</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalScroll}>
                {dashboard.memberProgress.map((member) => (
                  <View key={member.memberId} style={[styles.memberCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <MemberAvatar
                      displayName={member.displayName}
                      avatarUrl={member.avatarUrl}
                      size={48}
                      showStatus
                      status={member.status}
                    />
                    <Text style={[styles.memberName, { color: colors.foreground }]} numberOfLines={1}>
                      {member.displayName.split(' ')[0]}
                    </Text>
                    <Text style={[styles.memberPercent, { color: colors.primary }]}>{member.percentComplete}%</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          <View style={styles.quickActionsContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9 },
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (dashboard?.featuredJar) {
                  router.push(`/contribution/${dashboard.featuredJar.id}`);
                }
              }}
            >
              <Feather name="plus" size={20} color={colors.primaryForeground} />
              <Text style={[styles.actionButtonText, { color: colors.primaryForeground }]}>Add Funds</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: colors.secondary },
                pressed && { opacity: 0.8 },
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push('/create-jar');
              }}
            >
              <Feather name="archive" size={20} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: colors.primary }]}>New Jar</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
  },
  header: {
    marginBottom: 24,
  },
  greeting: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  dateText: {
    fontSize: 16,
    fontWeight: '500',
  },
  heroCard: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    height: 280,
    marginBottom: 24,
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  heroContent: {
    flex: 1,
    padding: 24,
    justifyContent: 'space-between',
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  heroJarName: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 4,
  },
  heroDestination: {
    fontSize: 16,
    color: '#E8F6EF',
    fontWeight: '500',
  },
  daysChip: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backdropFilter: 'blur(4px)', // Web
  },
  daysText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  heroBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  heroPercentText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  heroStats: {
    flex: 1,
  },
  heroAmountText: {
    fontSize: 16,
  },
  sectionCard: {
    padding: 20,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  progressText: {
    fontSize: 13,
  },
  scheduledInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginTop: 16,
    gap: 8,
  },
  scheduledText: {
    fontSize: 14,
    fontWeight: '500',
  },
  section: {
    marginBottom: 24,
  },
  sectionHeaderTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  horizontalScroll: {
    paddingRight: 16,
    gap: 12,
  },
  memberCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    width: 100,
  },
  memberName: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
  },
  memberPercent: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  quickActionsContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    borderRadius: 16,
    gap: 8,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
});
