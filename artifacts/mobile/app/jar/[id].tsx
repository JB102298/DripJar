import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  Platform,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { 
  useGetJar, 
  useGetJarHealth,
  useListJarMembers,
  useListMilestones,
  useListJarActivity,
  useListAgreements,
  useGetContributionSchedule,
  useCreateInvitation,
  useListJarInvitations,
  useRevokeInvitation,
  useLeaveJar,
  useRemoveJarMember,
  useUpdateJar,
  useCancelJar,
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
import { ScheduleSetupSheet } from '@/components/ScheduleSetupSheet';
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
  const [scheduleSheetVisible, setScheduleSheetVisible] = useState(false);
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteError, setInviteError] = useState('');

  const { data: jar, isLoading: jarLoading, refetch: refetchJar } = useGetJar(id!, { query: { enabled: !!id } });
  const { data: health, refetch: refetchHealth } = useGetJarHealth(id!, { query: { enabled: !!id } });
  const { data: members, refetch: refetchMembers } = useListJarMembers(id!, { query: { enabled: !!id && activeTab === 'Members' } });
  const { data: milestones, refetch: refetchMilestones } = useListMilestones(id!, { query: { enabled: !!id && activeTab === 'Milestones' } });
  const { data: activity, refetch: refetchActivity } = useListJarActivity(id!, undefined, { query: { enabled: !!id && activeTab === 'Activity' } });
  const { data: agreements, refetch: refetchAgreements } = useListAgreements(id!, { query: { enabled: !!id && activeTab === 'Agreements' } });
  const { data: mySchedule, refetch: refetchSchedule } = useGetContributionSchedule(id!, { query: { enabled: !!id && activeTab === 'Overview' } });

  const createInvitationMutation = useCreateInvitation();
  const leaveJarMutation = useLeaveJar();
  const removeMemberMutation = useRemoveJarMember();
  const revokeInvitationMutation = useRevokeInvitation();
  const updateJarMutation = useUpdateJar();
  const cancelJarMutation = useCancelJar();

  const isOrganizerUser = jar?.organizerId === user?.id;
  // Cast matches the queryKey-less options shape used throughout this app
  // (see pre-existing useGetJar/useListJarMembers calls above).
  const { data: sentInvitations, refetch: refetchInvitations } = useListJarInvitations(id!, {
    query: { enabled: !!id && isOrganizerUser && activeTab === 'Settings' } as never,
  });

  // Settings tab edit state
  const [settingsName, setSettingsName] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
  const [settingsDestination, setSettingsDestination] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  React.useEffect(() => {
    if (jar && !settingsLoaded) {
      setSettingsName(jar.name ?? '');
      setSettingsDescription(jar.description ?? '');
      setSettingsDestination(jar.destination ?? '');
      setSettingsLoaded(true);
    }
  }, [jar, settingsLoaded]);

  const confirm = (title: string, message: string, onConfirm: () => void, confirmLabel = 'Confirm') => {
    if (Platform.OS === 'web') {
      if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    } else {
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: confirmLabel, style: 'destructive', onPress: onConfirm },
      ]);
    }
  };

  const notify = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
    else Alert.alert(title, message);
  };

  const handleLeaveJar = () => {
    confirm(
      'Leave this jar?',
      'You will lose access to this jar. Your contribution history will be preserved.',
      async () => {
        try {
          await leaveJarMutation.mutateAsync({ jarId: id! });
          router.replace('/(tabs)/jars');
        } catch (e: any) {
          notify('Could not leave jar', e?.message ?? 'Something went wrong. Please try again.');
        }
      },
      'Leave Jar',
    );
  };

  const handleRemoveMember = (memberId: string, name: string) => {
    confirm(
      `Remove ${name}?`,
      `${name} will lose access to this jar. Their contribution history will be preserved.`,
      async () => {
        try {
          await removeMemberMutation.mutateAsync({ jarId: id!, memberId });
          await refetchMembers();
        } catch (e: any) {
          notify('Could not remove member', e?.message ?? 'Something went wrong. Please try again.');
        }
      },
      'Remove',
    );
  };

  const handleRevokeInvitation = (invitationId: string, email: string) => {
    confirm(
      'Cancel this invitation?',
      `The invitation sent to ${email} will stop working immediately.`,
      async () => {
        try {
          await revokeInvitationMutation.mutateAsync({ jarId: id!, invitationId });
          await refetchInvitations();
        } catch (e: any) {
          notify('Could not cancel invitation', e?.message ?? 'Something went wrong. Please try again.');
        }
      },
      'Cancel Invitation',
    );
  };

  const handleSaveSettings = async () => {
    if (!settingsName.trim()) {
      setSettingsError('Jar name is required');
      return;
    }
    setSettingsError('');
    setSettingsSaving(true);
    try {
      await updateJarMutation.mutateAsync({
        jarId: id!,
        data: {
          name: settingsName.trim(),
          description: settingsDescription.trim() || undefined,
          destination: settingsDestination.trim() || undefined,
        },
      });
      await refetchJar();
      notify('Saved', 'Jar settings have been updated.');
    } catch (e: any) {
      setSettingsError(e?.message ?? 'Could not save settings. Please try again.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleCancelJar = () => {
    confirm(
      'Cancel this jar?',
      'This permanently closes the jar for all members. No further contributions can be recorded. This cannot be undone.',
      async () => {
        try {
          await cancelJarMutation.mutateAsync({ jarId: id! });
          await refetchJar();
          notify('Jar cancelled', 'This jar has been cancelled.');
        } catch (e: any) {
          notify('Could not cancel jar', e?.message ?? 'Something went wrong. Please try again.');
        }
      },
      'Cancel Jar',
    );
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await refetchJar();
    await refetchHealth();
    if (activeTab === 'Overview') await refetchSchedule();
    if (activeTab === 'Members') await refetchMembers();
    if (activeTab === 'Milestones') await refetchMilestones();
    if (activeTab === 'Activity') await refetchActivity();
    if (activeTab === 'Agreements') await refetchAgreements();
    setRefreshing(false);
  };

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const renderScheduleCard = () => {
    const hasSchedule = mySchedule && mySchedule.isActive;
    const freqLabel = hasSchedule
      ? mySchedule.frequency === 'weekly'
        ? 'Weekly'
        : mySchedule.frequency === 'biweekly'
        ? 'Every 2 weeks'
        : mySchedule.frequency === 'monthly'
        ? 'Monthly'
        : mySchedule.frequency
      : null;

    return (
      <View style={[styles.scheduleCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.scheduleCardHeader}>
          <View style={styles.scheduleCardLeft}>
            <Feather name="repeat" size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[styles.scheduleCardTitle, { color: colors.foreground }]}>
              {hasSchedule ? 'Your Schedule' : 'Contribution Schedule'}
            </Text>
          </View>
          <Pressable
            onPress={() => setScheduleSheetVisible(true)}
            style={[styles.scheduleEditBtn, { backgroundColor: colors.secondary }]}
          >
            <Feather name={hasSchedule ? 'edit-2' : 'plus'} size={14} color={colors.primary} />
            <Text style={[styles.scheduleEditBtnText, { color: colors.primary }]}>
              {hasSchedule ? 'Edit' : 'Set Up'}
            </Text>
          </Pressable>
        </View>

        {hasSchedule ? (
          <View style={styles.scheduleDetails}>
            {mySchedule.isPaused && (
              <View style={[styles.pausedBadge, { backgroundColor: colors.muted }]}>
                <Feather name="pause" size={12} color={colors.mutedForeground} />
                <Text style={[styles.pausedText, { color: colors.mutedForeground }]}>Paused</Text>
              </View>
            )}
            <View style={styles.scheduleDetailRow}>
              <Text style={[styles.scheduleDetailLabel, { color: colors.mutedForeground }]}>Frequency</Text>
              <Text style={[styles.scheduleDetailValue, { color: colors.foreground }]}>{freqLabel}</Text>
            </View>
            <View style={styles.scheduleDetailRow}>
              <Text style={[styles.scheduleDetailLabel, { color: colors.mutedForeground }]}>Amount</Text>
              <Text style={[styles.scheduleDetailValue, { color: colors.foreground }]}>
                {formatCurrency(mySchedule.amountCents)}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={[styles.scheduleEmptyText, { color: colors.mutedForeground }]}>
            Set up a recurring schedule so you never miss a contribution.
          </Text>
        )}
      </View>
    );
  };

  const PHASE_COLORS: Record<string, { bg: string; text: string }> = {
    Draft:      { bg: '#F3F4F6', text: '#6B7280' },
    Inviting:   { bg: '#EFF6FF', text: '#2563EB' },
    Saving:     { bg: '#ECFDF5', text: '#059669' },
    Commitment: { bg: '#FEF3C7', text: '#D97706' },
    Completed:  { bg: '#F0FDF4', text: '#16A34A' },
    Cancelled:  { bg: '#FEF2F2', text: '#DC2626' },
  };

  const renderPhaseBadge = () => {
    const phase = (jar as any)?.phase as string | undefined;
    if (!phase) return null;
    const style = PHASE_COLORS[phase] ?? { bg: colors.muted, text: colors.mutedForeground };
    return (
      <View style={[styles.phaseBadge, { backgroundColor: style.bg }]}>
        <Feather
          name={phase === 'Commitment' ? 'lock' : phase === 'Saving' ? 'trending-up' : 'info'}
          size={12}
          color={style.text}
          style={{ marginRight: 4 }}
        />
        <Text style={[styles.phaseBadgeText, { color: style.text }]}>{phase} Phase</Text>
      </View>
    );
  };

  const renderCutoffBanner = () => {
    const phase = (jar as any)?.phase as string | undefined;
    const daysUntilCutoff = (jar as any)?.daysUntilCutoff as number | null | undefined;
    const cutoffDate = (jar as any)?.cutoffDate as string | null | undefined;
    if (!cutoffDate) return null;
    if (phase === 'Commitment') {
      return (
        <View style={[styles.cutoffBanner, { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' }]}>
          <Feather name="lock" size={14} color="#D97706" style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.cutoffBannerTitle, { color: '#92400E' }]}>Commitment Phase Active</Text>
            <Text style={[styles.cutoffBannerSub, { color: '#B45309' }]}>
              Contribution schedules are now locked. Contributions are still welcome.
            </Text>
          </View>
        </View>
      );
    }
    if (daysUntilCutoff !== null && daysUntilCutoff !== undefined && daysUntilCutoff <= 7) {
      return (
        <View style={[styles.cutoffBanner, { backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }]}>
          <Feather name="clock" size={14} color="#EA580C" style={{ marginRight: 8 }} />
          <Text style={[styles.cutoffBannerTitle, { color: '#9A3412' }]}>
            Commitment phase in {daysUntilCutoff} day{daysUntilCutoff === 1 ? '' : 's'}
          </Text>
        </View>
      );
    }
    if (daysUntilCutoff !== null && daysUntilCutoff !== undefined) {
      return (
        <View style={[styles.cutoffBanner, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="calendar" size={14} color={colors.mutedForeground} style={{ marginRight: 8 }} />
          <Text style={[styles.cutoffBannerSub, { color: colors.mutedForeground }]}>
            Commitment phase starts in {daysUntilCutoff} days ({cutoffDate})
          </Text>
        </View>
      );
    }
    return null;
  };

  const renderOverview = () => {
    if (!jar) return null;
    const phase = (jar as any)?.phase as string | undefined;
    const isCommitment = phase === 'Commitment';
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
            {renderPhaseBadge()}
          </View>
        </View>

        {renderCutoffBanner()}

        {health && (
          <View style={[styles.healthCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <JarHealthBadge status={health.status} />
            <Text style={[styles.healthMessage, { color: colors.foreground }]}>{health.message}</Text>
          </View>
        )}

        {isCommitment ? (
          <View style={[styles.scheduleCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.scheduleCardHeader}>
              <View style={styles.scheduleCardLeft}>
                <Feather name="lock" size={16} color={colors.mutedForeground} style={{ marginRight: 8 }} />
                <Text style={[styles.scheduleCardTitle, { color: colors.mutedForeground }]}>Schedule Locked</Text>
              </View>
            </View>
            <Text style={[styles.scheduleEmptyText, { color: colors.mutedForeground }]}>
              Contribution schedules cannot be changed during the Commitment phase.
            </Text>
          </View>
        ) : (
          renderScheduleCard()
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

  const handleSendInvite = async () => {
    if (!inviteEmail.trim()) {
      setInviteError('Please enter an email address');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail.trim())) {
      setInviteError('Please enter a valid email address');
      return;
    }
    setInviteError('');
    setInviteSending(true);
    try {
      await createInvitationMutation.mutateAsync({
        jarId: id!,
        data: { email: inviteEmail.trim().toLowerCase() },
      });
      setInviteModalVisible(false);
      setInviteEmail('');
      Alert.alert('Invitation sent!', `An invitation has been sent to ${inviteEmail.trim()}.`);
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to send invitation. Please try again.';
      setInviteError(msg);
    } finally {
      setInviteSending(false);
    }
  };

  const renderMembers = () => {
    if (!members) return <SkeletonLoader height={200} />;
    return (
      <View style={styles.tabContent}>
        {isOrganizer && (
          <Pressable
            style={[styles.inviteButton, { backgroundColor: colors.primary }]}
            onPress={() => { setInviteEmail(''); setInviteError(''); setInviteModalVisible(true); }}
          >
            <Feather name="user-plus" size={18} color="#fff" />
            <Text style={styles.inviteButtonText}>Invite Member</Text>
          </Pressable>
        )}
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
            {isOrganizerUser && member.userId !== user?.id && (
              <Pressable
                onPress={() => handleRemoveMember(member.id, member.profile?.displayName || 'this member')}
                style={styles.memberRemoveBtn}
                testID={`remove-member-${member.id}`}
              >
                <Feather name="user-x" size={18} color={colors.destructive} />
              </Pressable>
            )}
          </View>
        ))}
        {members.length === 0 && !isOrganizer && <EmptyState icon="users" title="No members yet" />}
        {!isOrganizerUser && (
          <Pressable
            onPress={handleLeaveJar}
            style={[styles.leaveJarButton, { borderColor: colors.destructive }]}
            testID="leave-jar-button"
          >
            <Feather name="log-out" size={16} color={colors.destructive} />
            <Text style={[styles.leaveJarText, { color: colors.destructive }]}>Leave Jar</Text>
          </Pressable>
        )}
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
    if (!isOrganizerUser) {
      return (
        <View style={styles.tabContent}>
          <EmptyState icon="lock" title="Organizer only" description="Only the jar organizer can change settings." />
          <Pressable
            onPress={handleLeaveJar}
            style={[styles.leaveJarButton, { borderColor: colors.destructive }]}
            testID="leave-jar-button-settings"
          >
            <Feather name="log-out" size={16} color={colors.destructive} />
            <Text style={[styles.leaveJarText, { color: colors.destructive }]}>Leave Jar</Text>
          </Pressable>
        </View>
      );
    }

    const jarClosed = jar ? ['Cancelled', 'Completed'].includes(jar.status) : false;

    return (
      <View style={styles.tabContent}>
        {jarClosed && (
          <View style={[styles.settingsNotice, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="info" size={16} color={colors.mutedForeground} />
            <Text style={[styles.settingsNoticeText, { color: colors.mutedForeground }]}>
              This jar is {jar!.status.toLowerCase()} and can no longer be edited.
            </Text>
          </View>
        )}

        {/* Editable details */}
        <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.settingsSectionTitle, { color: colors.foreground }]}>Jar Details</Text>

          <Text style={[styles.settingsLabel, { color: colors.mutedForeground }]}>Name</Text>
          <TextInput
            style={[styles.settingsInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            value={settingsName}
            onChangeText={setSettingsName}
            editable={!jarClosed}
            testID="settings-name-input"
          />

          <Text style={[styles.settingsLabel, { color: colors.mutedForeground }]}>Destination</Text>
          <TextInput
            style={[styles.settingsInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            value={settingsDestination}
            onChangeText={setSettingsDestination}
            editable={!jarClosed}
            testID="settings-destination-input"
          />

          <Text style={[styles.settingsLabel, { color: colors.mutedForeground }]}>Description</Text>
          <TextInput
            style={[styles.settingsInput, styles.settingsInputMultiline, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            value={settingsDescription}
            onChangeText={setSettingsDescription}
            multiline
            editable={!jarClosed}
            testID="settings-description-input"
          />

          <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>
            The goal amount and approval threshold are locked once the jar is launched, so
            everyone's targets stay consistent.
          </Text>

          {settingsError ? (
            <Text style={{ color: colors.destructive, fontSize: 14, marginTop: 8 }}>{settingsError}</Text>
          ) : null}

          {!jarClosed && (
            <Pressable
              style={[styles.settingsSaveButton, { backgroundColor: colors.primary }]}
              onPress={handleSaveSettings}
              disabled={settingsSaving}
              testID="settings-save-button"
            >
              <Text style={styles.settingsSaveText}>{settingsSaving ? 'Saving…' : 'Save Changes'}</Text>
            </Pressable>
          )}
        </View>

        {/* Sent invitations */}
        <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.settingsSectionTitle, { color: colors.foreground }]}>Sent Invitations</Text>
          {!sentInvitations ? (
            <SkeletonLoader height={60} />
          ) : sentInvitations.length === 0 ? (
            <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>No invitations sent yet.</Text>
          ) : (
            sentInvitations.map((inv) => (
              <View key={inv.id} style={[styles.invitationRow, { borderBottomColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.invitationEmail, { color: colors.foreground }]} numberOfLines={1}>
                    {inv.email}
                  </Text>
                  <Text style={[styles.invitationMeta, { color: colors.mutedForeground }]}>
                    {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                    {inv.sentAt ? ` · Sent ${new Date(inv.sentAt).toLocaleDateString()}` : ''}
                    {inv.status === 'pending' && inv.expiresAt
                      ? ` · Expires ${new Date(inv.expiresAt).toLocaleDateString()}`
                      : ''}
                  </Text>
                </View>
                {inv.status === 'pending' && (
                  <Pressable
                    onPress={() => handleRevokeInvitation(inv.id, inv.email)}
                    style={[styles.invitationCancelBtn, { borderColor: colors.destructive }]}
                    testID={`revoke-invitation-${inv.id}`}
                  >
                    <Text style={{ color: colors.destructive, fontSize: 13, fontWeight: '600' }}>Cancel</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}
        </View>

        {/* Danger zone */}
        {!jarClosed && (
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
            <Text style={[styles.settingsSectionTitle, { color: colors.destructive }]}>Danger Zone</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 14, marginBottom: 16 }}>
              Cancelling the jar permanently closes it for all members. Contribution history is
              preserved, but no further contributions can be recorded.
            </Text>
            <Pressable
              style={[styles.cancelJarButton, { borderColor: colors.destructive }]}
              onPress={handleCancelJar}
              testID="cancel-jar-button"
            >
              <Feather name="x-circle" size={16} color={colors.destructive} />
              <Text style={{ color: colors.destructive, fontSize: 15, fontWeight: '600' }}>Cancel Jar</Text>
            </Pressable>
          </View>
        )}
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
      {/* Invite Member Modal */}
      <Modal
        visible={inviteModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setInviteModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setInviteModalVisible(false)} />
          <View style={[styles.modalSheet, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Invite Member</Text>
              <Pressable onPress={() => setInviteModalVisible(false)}>
                <Feather name="x" size={24} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <Text style={[styles.modalSubtitle, { color: colors.mutedForeground }]}>
              Enter the email address of the person you'd like to invite to {jar?.name}.
            </Text>
            <View style={[styles.modalInputContainer, { backgroundColor: colors.background, borderColor: inviteError ? '#EF4444' : colors.border }]}>
              <Feather name="mail" size={18} color={colors.mutedForeground} style={{ marginRight: 10 }} />
              <TextInput
                style={[styles.modalInput, { color: colors.foreground }]}
                placeholder="friend@example.com"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="email-address"
                autoFocus
                value={inviteEmail}
                onChangeText={text => { setInviteEmail(text); setInviteError(''); }}
                onSubmitEditing={handleSendInvite}
                returnKeyType="send"
              />
            </View>
            {inviteError ? (
              <Text style={[styles.modalError, { color: '#EF4444' }]}>{inviteError}</Text>
            ) : null}
            <Pressable
              style={[styles.modalSendButton, { backgroundColor: inviteSending ? colors.muted : colors.primary }]}
              onPress={handleSendInvite}
              disabled={inviteSending}
            >
              {inviteSending ? (
                <Text style={[styles.modalSendText, { color: colors.mutedForeground }]}>Sending…</Text>
              ) : (
                <>
                  <Feather name="send" size={18} color="#fff" />
                  <Text style={styles.modalSendText}>Send Invitation</Text>
                </>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ScheduleSetupSheet
        visible={scheduleSheetVisible}
        jarId={id!}
        onClose={() => {
          setScheduleSheetVisible(false);
          refetchSchedule();
        }}
      />
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
  memberRemoveBtn: {
    padding: 10,
  },
  leaveJarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    height: 48,
    marginTop: 16,
  },
  leaveJarText: {
    fontSize: 15,
    fontWeight: '600',
  },
  settingsCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 16,
  },
  settingsSectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  settingsLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 8,
  },
  settingsInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 4,
  },
  settingsInputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  settingsHint: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  settingsSaveButton: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  settingsSaveText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  settingsNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  settingsNoticeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  invitationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  invitationEmail: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  invitationMeta: {
    fontSize: 12,
  },
  invitationCancelBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelJarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    height: 48,
  },
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
  // Schedule card
  scheduleCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 16,
  },
  scheduleCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  scheduleCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scheduleCardTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  scheduleEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  scheduleEditBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  scheduleDetails: {
    gap: 8,
  },
  scheduleDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scheduleDetailLabel: {
    fontSize: 14,
  },
  scheduleDetailValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  pausedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: 4,
  },
  pausedText: {
    fontSize: 12,
    fontWeight: '600',
  },
  scheduleEmptyText: {
    fontSize: 14,
    lineHeight: 20,
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
  // Phase badge in overview
  phaseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  phaseBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  // Cutoff/commitment banner
  cutoffBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  cutoffBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  cutoffBannerSub: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
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
  // Invite button (Members tab)
  inviteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: 12,
    marginBottom: 16,
  },
  inviteButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  // Invite modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  modalSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
  },
  modalInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 52,
    marginBottom: 8,
  },
  modalInput: {
    flex: 1,
    fontSize: 16,
  },
  modalError: {
    fontSize: 13,
    marginBottom: 16,
  },
  modalSendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 12,
    marginTop: 8,
  },
  modalSendText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 'bold',
  },
});
