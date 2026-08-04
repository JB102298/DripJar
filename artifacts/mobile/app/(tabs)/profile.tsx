import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, Platform, Switch } from 'react-native';

type PrefKey = 'emailPrefContributionReminders' | 'emailPrefCutoffReminders' | 'emailPrefLifecycle';
const PREF_ITEMS: Array<{ key: PrefKey; label: string; sub: string; icon: React.ComponentProps<typeof Feather>['name'] }> = [
  { key: 'emailPrefContributionReminders', label: 'Contribution Reminders', sub: 'Due & missed contribution alerts', icon: 'repeat' },
  { key: 'emailPrefCutoffReminders', label: 'Cutoff Reminders', sub: 'Approaching commitment phase', icon: 'calendar' },
  { key: 'emailPrefLifecycle', label: 'Lifecycle Notifications', sub: 'Jar status changes & milestones', icon: 'bell' },
];
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/auth-context';
import { useGetDashboard, useSendVerification, useGetAuthPreferences, useUpdateAuthPreferences } from '@workspace/api-client-react';
import { MemberAvatar } from '@/components/MemberAvatar';
import { Feather } from '@expo/vector-icons';

export default function ProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, user, logout } = useAuth();
  
  const { data: dashboard } = useGetDashboard();
  const { mutateAsync: sendVerification, isPending: isSendingVerification } = useSendVerification();
  const { data: emailPrefs } = useGetAuthPreferences();
  const { mutateAsync: updatePrefs } = useUpdateAuthPreferences();
  const [verificationSent, setVerificationSent] = React.useState(false);
  const [updatingPref, setUpdatingPref] = React.useState<string | null>(null);

  const handleResendVerification = async () => {
    try {
      await sendVerification();
      setVerificationSent(true);
    } catch {
      if (Platform.OS === 'web') {
        window.alert('Could not send the verification email. Please try again later.');
      } else {
        Alert.alert('Error', 'Could not send the verification email. Please try again later.');
      }
    }
  };

  const handleLogout = () => {
    Alert.alert(
      "Sign Out",
      "Are you sure you want to sign out?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Sign Out", 
          style: "destructive",
          onPress: async () => {
            await logout();
            router.replace('/(auth)');
          }
        }
      ]
    );
  };

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const SettingRow = ({ icon, title, onPress, destructive = false, placeholder = false }: any) => (
    <Pressable
      style={({ pressed }) => [
        styles.settingRow,
        { borderBottomColor: colors.border },
        pressed && { backgroundColor: colors.secondary },
      ]}
      onPress={placeholder ? undefined : onPress}
    >
      <View style={styles.settingIconContainer}>
        <Feather name={icon} size={20} color={destructive ? colors.destructive : colors.foreground} />
      </View>
      <Text style={[
        styles.settingTitle, 
        { color: destructive ? colors.destructive : colors.foreground },
        placeholder && { opacity: 0.5 }
      ]}>
        {title}
      </Text>
      {placeholder ? (
        <View style={[styles.comingSoonChip, { backgroundColor: colors.muted }]}>
          <Text style={[styles.comingSoonText, { color: colors.mutedForeground }]}>Soon</Text>
        </View>
      ) : (
        <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
      )}
    </Pressable>
  );

  return (
    <ScrollView 
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 100 }}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            if (Platform.OS === 'web') {
              window.alert('Photo upload is coming soon!');
            } else {
              Alert.alert('Coming Soon', 'Photo upload will be available in a future update.');
            }
          }}
          style={styles.avatarWrapper}
        >
          <MemberAvatar 
            displayName={profile?.displayName || 'Traveler'} 
            avatarUrl={profile?.avatarUrl} 
            size={80} 
          />
          <View style={[styles.cameraOverlay, { backgroundColor: colors.primary }]}>
            <Feather name="camera" size={14} color="#fff" />
          </View>
        </Pressable>
        <Text style={[styles.name, { color: colors.foreground }]}>
          {profile?.displayName || `${profile?.firstName} ${profile?.lastName}`}
        </Text>
        <Text style={[styles.email, { color: colors.mutedForeground }]}>
          {user?.email}
        </Text>
        {user && !user.emailVerified ? (
          <View style={styles.verifyRow}>
            <View style={[styles.verifyBadge, { backgroundColor: colors.muted }]}>
              <Feather name="alert-circle" size={13} color={colors.warning} />
              <Text style={[styles.verifyBadgeText, { color: colors.mutedForeground }]}>
                Email not verified
              </Text>
            </View>
            {verificationSent ? (
              <Text style={[styles.verifySentText, { color: colors.success }]}>
                Verification email sent — check your inbox
              </Text>
            ) : (
              <Pressable onPress={handleResendVerification} disabled={isSendingVerification}>
                <Text style={[styles.verifyLink, { color: colors.primary }]}>
                  {isSendingVerification ? 'Sending…' : 'Resend verification email'}
                </Text>
              </Pressable>
            )}
          </View>
        ) : user?.emailVerified ? (
          <View style={[styles.verifyBadge, { backgroundColor: colors.muted, marginTop: 8 }]}>
            <Feather name="check-circle" size={13} color={colors.success} />
            <Text style={[styles.verifyBadgeText, { color: colors.mutedForeground }]}>
              Email verified
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.statsContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.foreground }]}>
            {dashboard?.totalJars || 0}
          </Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Jars</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.primary }]}>
            {formatCurrency(dashboard?.personalProgress?.contributedAmountCents || 0)}
          </Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Contributed</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Account</Text>
        <View style={[styles.settingsGroup, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SettingRow icon="user" title="Edit Profile" onPress={() => router.push('/(auth)/profile-setup')} />
          <SettingRow icon="lock" title="Change Password" onPress={() => router.push('/change-password')} />
          <SettingRow icon="credit-card" title="Payment Methods" placeholder />
        </View>
      </View>

      {/* Email notification preferences */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Notifications</Text>
        <View style={[styles.settingsGroup, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {PREF_ITEMS.map(({ key, label, sub, icon }, idx) => (
            <View
              key={key}
              style={[
                styles.prefRow,
                { borderBottomColor: colors.border },
                idx === 2 && { borderBottomWidth: 0 },
              ]}
            >
              <View style={styles.settingIconContainer}>
                <Feather name={icon} size={20} color={colors.foreground} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingTitle, { color: colors.foreground }]}>{label}</Text>
                <Text style={[styles.prefSub, { color: colors.mutedForeground }]}>{sub}</Text>
              </View>
              <Switch
                value={emailPrefs ? emailPrefs[key] : true}
                onValueChange={async (val) => {
                  if (updatingPref) return;
                  setUpdatingPref(key);
                  try {
                    await updatePrefs({ data: { [key]: val } });
                  } finally {
                    setUpdatingPref(null);
                  }
                }}
                disabled={updatingPref === key}
                trackColor={{ false: colors.muted, true: colors.primary }}
                thumbColor="#fff"
              />
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Legal & Support</Text>
        <View style={[styles.settingsGroup, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SettingRow icon="help-circle" title="Help & Support" placeholder />
          <SettingRow icon="file-text" title="Terms of Service" placeholder />
          <SettingRow icon="shield" title="Privacy Policy" placeholder />
        </View>
      </View>

      <View style={styles.section}>
        <View style={[styles.settingsGroup, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SettingRow icon="log-out" title="Sign Out" onPress={handleLogout} destructive />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  avatarWrapper: {
    position: 'relative',
  },
  cameraOverlay: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 4,
  },
  email: {
    fontSize: 16,
  },
  verifyRow: {
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  verifyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  verifyBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  verifyLink: {
    fontSize: 13,
    fontWeight: '600',
  },
  verifySentText: {
    fontSize: 13,
  },
  statsContainer: {
    flexDirection: 'row',
    marginHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 20,
    marginBottom: 32,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    height: '100%',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 14,
  },
  section: {
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  settingsGroup: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  settingIconContainer: {
    width: 32,
    alignItems: 'flex-start',
  },
  settingTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  comingSoonChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  comingSoonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  prefSub: {
    fontSize: 12,
    marginTop: 1,
  },
});
