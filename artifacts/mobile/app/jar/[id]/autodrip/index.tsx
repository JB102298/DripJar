/**
 * AutoDrip Status Screen — Phase 4E
 * Route: /jar/[id]/autodrip  (Expo Router: app/jar/[id]/autodrip/index.tsx)
 *
 * Shows current AutoDrip authorization status for the contributor.
 * Provides controls to pause, resume, cancel, and navigate to setup.
 *
 * State machine (contributor view):
 *   no auth    → "Set up AutoDrip" CTA → /jar/[id]/autodrip/setup
 *   active     → status card + Pause + Cancel controls
 *   paused     → status card + Resume + Cancel controls
 *   needs_attention → alert banner + reason + Resume (after fixing PM) + Cancel
 *   cancelled  → terminal message
 *   completed  → terminal message
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { customFetch } from '@workspace/api-client-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type AuthStatus = 'active' | 'paused' | 'needs_attention' | 'cancelled' | 'completed';

interface AutoDripRun {
  id: string;
  status: string;
  scheduledFor: string;
  principalCents: number;
  completedAt: string | null;
  failureCode: string | null;
}

interface AutoDripState {
  enabled: boolean;
  jarTimeZone?: string;
  authorization?: {
    id: string;
    status: AuthStatus;
    principalCents: number;
    frequency: string;
    nextRunAt: string;
    lastRunAt: string | null;
    needsAttentionReason: string | null;
    authorizedAt: string;
  };
  paymentMethod?: {
    id: string;
    type: string;
    displayBrand: string | null;
    last4: string | null;
    bankName: string | null;
    status: string;
  } | null;
  recentRuns?: AutoDripRun[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function fmtFreq(freq: string): string {
  const map: Record<string, string> = {
    weekly: 'Weekly',
    biweekly: 'Every 2 weeks',
    monthly: 'Monthly',
    twiceMonthly: 'Twice a month',
  };
  return map[freq] ?? freq;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function pmLabel(pm: NonNullable<AutoDripState['paymentMethod']>): string {
  if (pm.type === 'card') return `${pm.displayBrand ?? 'Card'} •••• ${pm.last4 ?? '----'}`;
  return `${pm.bankName ?? 'Bank'} •••• ${pm.last4 ?? '----'}`;
}

function statusColor(status: AuthStatus, colors: ReturnType<typeof useColors>): string {
  switch (status) {
    case 'active': return '#16A34A';
    case 'paused': return '#D97706';
    case 'needs_attention': return '#DC2626';
    case 'cancelled': case 'completed': return colors.mutedForeground;
  }
}

function statusLabel(status: AuthStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'paused': return 'Paused';
    case 'needs_attention': return 'Needs Attention';
    case 'cancelled': return 'Cancelled';
    case 'completed': return 'Completed';
  }
}

function runStatusIcon(status: string): React.ComponentProps<typeof Feather>['name'] {
  if (status === 'succeeded') return 'check-circle';
  if (status === 'failed' || status === 'action_required') return 'x-circle';
  if (status === 'skipped') return 'minus-circle';
  return 'clock';
}

function runStatusColor(status: string): string {
  if (status === 'succeeded') return '#16A34A';
  if (status === 'failed' || status === 'action_required') return '#DC2626';
  if (status === 'skipped') return '#9CA3AF';
  return '#D97706';
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AutoDripStatusScreen() {
  const { id: jarId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [state, setState] = useState<AutoDripState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const data = await customFetch<AutoDripState>(`/jars/${jarId}/autodrip`);
      setState(data);
    } catch {
      // keep existing
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jarId]);

  React.useEffect(() => { void load(); }, [load]);

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

  const handlePause = () => {
    confirm('Pause AutoDrip?', 'AutoDrip will be paused. No automatic Drips will be created until you resume.', async () => {
      setActing('pause');
      try {
        await customFetch(`/jars/${jarId}/autodrip/pause`, { method: 'POST' });
        await load();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to pause';
        if (Platform.OS === 'web') window.alert(msg);
        else Alert.alert('Error', msg);
      } finally { setActing(null); }
    }, 'Pause');
  };

  const handleResume = async () => {
    setActing('resume');
    try {
      await customFetch(`/jars/${jarId}/autodrip/resume`, { method: 'POST' });
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to resume';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    } finally { setActing(null); }
  };

  const handleCancel = () => {
    confirm(
      'Cancel AutoDrip?',
      'AutoDrip will be permanently cancelled. You can set it up again later.',
      async () => {
        setActing('cancel');
        try {
          await customFetch(`/jars/${jarId}/autodrip`, { method: 'DELETE' });
          await load();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Failed to cancel';
          if (Platform.OS === 'web') window.alert(msg);
          else Alert.alert('Error', msg);
        } finally { setActing(null); }
      },
      'Cancel AutoDrip',
    );
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const auth = state?.authorization;
  const pm = state?.paymentMethod;
  const runs = state?.recentRuns ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>AutoDrip</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
      >
        {!state?.enabled || !auth ? (
          // ── Not enabled ───────────────────────────────────────────────────
          <View style={styles.disabledSection}>
            <Feather name="zap" size={48} color={colors.primary} />
            <Text style={[styles.disabledTitle, { color: colors.foreground }]}>AutoDrip is Off</Text>
            <Text style={[styles.disabledBody, { color: colors.mutedForeground }]}>
              AutoDrip makes your savings automatic. Set it up once and DripJar will Drip on your schedule — no manual steps needed.
            </Text>
            <Pressable
              onPress={() => router.push(`/jar/${jarId}/autodrip/setup` as never)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Feather name="zap" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Set Up AutoDrip</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── Status card ─────────────────────────────────────────────── */}
            {auth.status === 'needs_attention' && auth.needsAttentionReason && (
              <View style={[styles.alertBanner, { backgroundColor: '#FEF2F2', borderColor: '#FECACA' }]}>
                <Feather name="alert-circle" size={18} color="#DC2626" />
                <Text style={[styles.alertText, { color: '#B91C1C' }]}>{auth.needsAttentionReason}</Text>
              </View>
            )}

            <View style={[styles.statusCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.statusRow}>
                <Text style={[styles.statusLabel, { color: colors.mutedForeground }]}>Status</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusColor(auth.status, colors) + '20' }]}>
                  <Text style={[styles.statusBadgeText, { color: statusColor(auth.status, colors) }]}>
                    {statusLabel(auth.status)}
                  </Text>
                </View>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Amount</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{fmt(auth.principalCents)} per Drip</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Frequency</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{fmtFreq(auth.frequency)}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Next Drip</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{fmtDate(auth.nextRunAt)}</Text>
              </View>
              {auth.lastRunAt && (
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Last Drip</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{fmtDate(auth.lastRunAt)}</Text>
                </View>
              )}
              {pm && (
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Payment</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{pmLabel(pm)}</Text>
                </View>
              )}
            </View>

            {/* ── Controls ────────────────────────────────────────────────── */}
            <View style={styles.controls}>
              {auth.status === 'active' && (
                <Pressable
                  onPress={handlePause}
                  disabled={acting !== null}
                  style={[styles.outlineBtn, { borderColor: colors.border }]}
                >
                  {acting === 'pause' ? <ActivityIndicator size="small" color={colors.foreground} /> : <Feather name="pause-circle" size={18} color={colors.foreground} />}
                  <Text style={[styles.outlineBtnText, { color: colors.foreground }]}>Pause AutoDrip</Text>
                </Pressable>
              )}

              {(auth.status === 'paused' || auth.status === 'needs_attention') && (
                <Pressable
                  onPress={handleResume}
                  disabled={acting !== null}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                >
                  {acting === 'resume' ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="play-circle" size={18} color="#fff" />}
                  <Text style={styles.primaryBtnText}>Resume AutoDrip</Text>
                </Pressable>
              )}

              {auth.status !== 'cancelled' && auth.status !== 'completed' && (
                <Pressable
                  onPress={handleCancel}
                  disabled={acting !== null}
                  style={[styles.outlineBtn, { borderColor: '#FECACA' }]}
                >
                  {acting === 'cancel' ? <ActivityIndicator size="small" color="#DC2626" /> : <Feather name="x-circle" size={18} color="#DC2626" />}
                  <Text style={[styles.outlineBtnText, { color: '#DC2626' }]}>Cancel AutoDrip</Text>
                </Pressable>
              )}

              {auth.status === 'needs_attention' && (
                <Pressable
                  onPress={() => router.push(`/jar/${jarId}/payment-methods` as never)}
                  style={[styles.outlineBtn, { borderColor: colors.border }]}
                >
                  <Feather name="credit-card" size={18} color={colors.foreground} />
                  <Text style={[styles.outlineBtnText, { color: colors.foreground }]}>Manage Payment Methods</Text>
                </Pressable>
              )}
            </View>

            {/* ── Recent runs ─────────────────────────────────────────────── */}
            {runs.length > 0 && (
              <View style={styles.runsSection}>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent Activity</Text>
                {runs.map(run => (
                  <View key={run.id} style={[styles.runRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Feather name={runStatusIcon(run.status)} size={16} color={runStatusColor(run.status)} style={styles.runIcon} />
                    <View style={styles.runInfo}>
                      <Text style={[styles.runDate, { color: colors.foreground }]}>{fmtDate(run.scheduledFor)}</Text>
                      <Text style={[styles.runAmount, { color: colors.mutedForeground }]}>{fmt(run.principalCents)} · {run.status}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4, marginRight: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 34 },
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  disabledSection: { alignItems: 'center', paddingVertical: 32, gap: 12 },
  disabledTitle: { fontSize: 22, fontWeight: '700' },
  disabledBody: { fontSize: 15, textAlign: 'center', lineHeight: 22, maxWidth: 320 },
  alertBanner: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  alertText: { flex: 1, fontSize: 14, lineHeight: 20 },
  statusCard: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 12 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusLabel: { fontSize: 14, fontWeight: '600' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusBadgeText: { fontSize: 13, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoLabel: { fontSize: 14 },
  infoValue: { fontSize: 14, fontWeight: '600' },
  controls: { gap: 10 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 12 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 12, borderWidth: 1.5 },
  outlineBtnText: { fontSize: 15, fontWeight: '600' },
  runsSection: { gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  runRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderRadius: 10 },
  runIcon: { marginRight: 10 },
  runInfo: { flex: 1 },
  runDate: { fontSize: 14, fontWeight: '600' },
  runAmount: { fontSize: 13, marginTop: 2 },
});
