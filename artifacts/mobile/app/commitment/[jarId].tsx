/**
 * Commitment Screen — Phase 4C
 *
 * Allows a jar member to lock in their contributed principal:
 *   1. Fetch commitment preview (POST /jars/:jarId/commitment/preview)
 *      — server validates phase gate, agreement acceptance, and builds lots
 *   2. Show the breakdown: total, per-lot allocations, agreement version
 *   3. User confirms → POST /jars/:jarId/commitment/confirm
 *   4. Success state with nav back
 *
 * Design decisions (D1–D4, locked in Phase 4C architecture):
 *   - Preview is fetched on mount; snapshot token (10-min expiry) is kept in state
 *   - Confirm is idempotent: re-sending the same snapshotToken returns the
 *     existing result (idempotent=true) rather than posting twice
 *   - If the agreement changes between preview and confirm, the server returns
 *     409 snapshot_stale — we re-fetch and show an updated preview
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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { customFetch } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommitmentLot {
  sourceFtId: string;
  principalCents: number;
  currency: string;
}

interface CommitmentPreview {
  snapshotToken: string;
  expiresAt: string;
  totalCommitCents: number;
  currency: string;
  agreementId: string;
  agreementVersion: string;
  lots: CommitmentLot[];
}

interface CommitmentConfirmResult {
  fundCommitmentId: string;
  status: string;
  totalCommittedCents: number;
  idempotent: boolean;
}

type FlowStep = 'loading' | 'preview' | 'confirming' | 'success' | 'error' | 'unavailable';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDollars(cents: number, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CommitmentScreen() {
  const { jarId } = useLocalSearchParams<{ jarId: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<FlowStep>('loading');
  const [preview, setPreview] = useState<CommitmentPreview | null>(null);
  const [confirmResult, setConfirmResult] = useState<CommitmentConfirmResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [unavailableReason, setUnavailableReason] = useState('');

  // ─── Fetch preview on mount ──────────────────────────────────────────────

  const fetchPreview = useCallback(async () => {
    setStep('loading');
    setErrorMessage('');
    try {
      const data = await customFetch<CommitmentPreview>(
        `/api/jars/${jarId}/commitment/preview`,
        { method: 'POST' },
      );
      setPreview(data);
      setStep('preview');
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string; message?: string } };
      const apiError = e?.body?.error ?? '';
      const apiMsg = e?.body?.message ?? '';

      if (
        apiError === 'PhaseGate' ||
        apiError === 'NoActiveAgreement' ||
        apiError === 'AgreementNotAccepted' ||
        apiError === 'NothingToCommit' ||
        apiError === 'AlreadyCommitted'
      ) {
        setUnavailableReason(apiMsg || apiError);
        setStep('unavailable');
      } else {
        setErrorMessage(apiMsg || 'Could not load commitment preview. Please try again.');
        setStep('error');
      }
    }
  }, [jarId]);

  // Run on mount
  React.useEffect(() => {
    void fetchPreview();
  }, [fetchPreview]);

  // ─── Confirm commitment ──────────────────────────────────────────────────

  const handleConfirm = async () => {
    if (!preview) return;
    setStep('confirming');
    try {
      const data = await customFetch<CommitmentConfirmResult>(
        `/api/jars/${jarId}/commitment/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ snapshotToken: preview.snapshotToken }),
        },
      );
      setConfirmResult(data);
      // Invalidate financial-related queries
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/activity`] });
      setStep('success');
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string; message?: string; reason?: string } };
      const apiError = e?.body?.error ?? '';
      const reason = e?.body?.reason ?? '';

      if (apiError === 'SnapshotStale') {
        // Agreement changed or snapshot expired — re-fetch preview
        Alert.alert(
          'Preview expired',
          reason === 'agreement_changed'
            ? 'The savings agreement was updated while you were reviewing. Please review the latest terms and confirm again.'
            : 'Your preview expired. Please review the updated details and confirm again.',
          [{ text: 'OK', onPress: () => void fetchPreview() }],
        );
      } else {
        setErrorMessage(e?.body?.message ?? 'Commitment failed. Please try again.');
        setStep('error');
      }
    }
  };

  // ─── Render helpers ──────────────────────────────────────────────────────

  const s = makeStyles(colors, insets);

  const renderHeader = () => (
    <View style={s.header}>
      <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
        <Feather name="arrow-left" size={22} color={colors.foreground} />
      </Pressable>
      <Text style={s.headerTitle}>Lock In Principal</Text>
      <View style={{ width: 34 }} />
    </View>
  );

  // ─── Loading ─────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <View style={s.screen}>
        {renderHeader()}
        <View style={s.centeredContent}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>Preparing your commitment…</Text>
        </View>
      </View>
    );
  }

  // ─── Unavailable ─────────────────────────────────────────────────────────

  if (step === 'unavailable') {
    return (
      <View style={s.screen}>
        {renderHeader()}
        <View style={s.centeredContent}>
          <View style={s.iconCircle}>
            <Feather name="lock" size={28} color={colors.mutedForeground} />
          </View>
          <Text style={s.unavailableTitle}>Commitment Unavailable</Text>
          <Text style={s.unavailableBody}>{unavailableReason}</Text>
          <Pressable style={s.secondaryBtn} onPress={() => router.back()}>
            <Text style={s.secondaryBtnText}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Error ───────────────────────────────────────────────────────────────

  if (step === 'error') {
    return (
      <View style={s.screen}>
        {renderHeader()}
        <View style={s.centeredContent}>
          <View style={[s.iconCircle, { backgroundColor: '#FEE2E2' }]}>
            <Feather name="alert-circle" size={28} color={colors.destructive} />
          </View>
          <Text style={s.errorTitle}>Something went wrong</Text>
          <Text style={s.errorBody}>{errorMessage}</Text>
          <Pressable style={s.primaryBtn} onPress={() => void fetchPreview()}>
            <Text style={s.primaryBtnText}>Try Again</Text>
          </Pressable>
          <Pressable style={[s.secondaryBtn, { marginTop: 8 }]} onPress={() => router.back()}>
            <Text style={s.secondaryBtnText}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Success ─────────────────────────────────────────────────────────────

  if (step === 'success') {
    const total = confirmResult?.totalCommittedCents ?? preview?.totalCommitCents ?? 0;
    const currency = preview?.currency ?? 'usd';
    return (
      <View style={s.screen}>
        {renderHeader()}
        <View style={s.centeredContent}>
          <View style={[s.iconCircle, { backgroundColor: '#DCFCE7' }]}>
            <Feather name="check-circle" size={32} color={colors.success} />
          </View>
          <Text style={s.successTitle}>Principal Locked!</Text>
          <Text style={s.successAmount}>{formatDollars(total, currency)}</Text>
          <Text style={s.successSubtitle}>
            Your contributed principal has been committed to this jar.
            {confirmResult?.idempotent ? ' (Already committed — no duplicate posting.)' : ''}
          </Text>
          <Pressable style={s.primaryBtn} onPress={() => router.back()}>
            <Text style={s.primaryBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Preview (default) ────────────────────────────────────────────────────

  if (!preview) return null;

  const isConfirming = step === 'confirming';

  return (
    <View style={s.screen}>
      {renderHeader()}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary card */}
        <View style={s.summaryCard}>
          <Text style={s.summaryLabel}>Total to commit</Text>
          <Text style={s.summaryAmount}>
            {formatDollars(preview.totalCommitCents, preview.currency)}
          </Text>
          <View style={s.summaryDivider} />
          <View style={s.summaryRow}>
            <Feather name="file-text" size={14} color={colors.mutedForeground} />
            <Text style={s.summaryMeta}>
              Agreement v{preview.agreementVersion}
            </Text>
          </View>
          <View style={s.summaryRow}>
            <Feather name="clock" size={14} color={colors.mutedForeground} />
            <Text style={s.summaryMeta}>
              Preview valid until{' '}
              {new Date(preview.expiresAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </Text>
          </View>
        </View>

        {/* Lots breakdown */}
        <Text style={s.sectionTitle}>Contributions being committed</Text>
        {preview.lots.map((lot, idx) => (
          <View key={lot.sourceFtId} style={s.lotRow}>
            <View style={s.lotIndex}>
              <Text style={s.lotIndexText}>{idx + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.lotAmount}>{formatDollars(lot.principalCents, lot.currency)}</Text>
              <Text style={s.lotId} numberOfLines={1}>
                txn: {lot.sourceFtId.slice(-8)}
              </Text>
            </View>
          </View>
        ))}

        {/* Info box */}
        <View style={s.infoBox}>
          <Feather name="info" size={14} color={colors.accentForeground} style={{ marginTop: 1 }} />
          <Text style={s.infoText}>
            Locking in your principal means your funds are committed to this jar's goal.
            Refunds may still be requested subject to the jar's rules.
          </Text>
        </View>

        {/* Confirm button */}
        <Pressable
          style={[s.primaryBtn, isConfirming && s.btnDisabled]}
          onPress={() => void handleConfirm()}
          disabled={isConfirming}
        >
          {isConfirming ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={s.primaryBtnText}>Confirm Commitment</Text>
          )}
        </Pressable>

        <Pressable style={s.secondaryBtn} onPress={() => router.back()} disabled={isConfirming}>
          <Text style={s.secondaryBtnText}>Cancel</Text>
        </Pressable>

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof import('@/hooks/useColors').useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: insets.top + 12,
      paddingHorizontal: 20,
      paddingBottom: 12,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backBtn: {
      width: 34,
      alignItems: 'flex-start',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: colors.foreground,
    },
    scrollContent: {
      padding: 20,
    },
    centeredContent: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    },
    iconCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 20,
    },
    loadingText: {
      marginTop: 16,
      fontSize: 15,
      color: colors.mutedForeground,
    },
    unavailableTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: 10,
    },
    unavailableBody: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
    },
    errorTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: 10,
    },
    errorBody: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
    },
    successTitle: {
      fontSize: 22,
      fontWeight: '800',
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: 8,
    },
    successAmount: {
      fontSize: 36,
      fontWeight: '700',
      color: colors.success,
      textAlign: 'center',
      marginBottom: 12,
    },
    successSubtitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 32,
    },
    summaryCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      padding: 20,
      marginBottom: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    summaryLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      marginBottom: 4,
    },
    summaryAmount: {
      fontSize: 32,
      fontWeight: '800',
      color: colors.foreground,
      marginBottom: 16,
    },
    summaryDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginBottom: 12,
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    summaryMeta: {
      fontSize: 13,
      color: colors.mutedForeground,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 10,
    },
    lotRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: colors.radius - 4,
      padding: 14,
      marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 12,
    },
    lotIndex: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lotIndexText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.secondaryForeground,
    },
    lotAmount: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.foreground,
    },
    lotId: {
      fontSize: 11,
      color: colors.mutedForeground,
      marginTop: 2,
    },
    infoBox: {
      flexDirection: 'row',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: colors.radius - 4,
      padding: 14,
      marginVertical: 20,
    },
    infoText: {
      flex: 1,
      fontSize: 13,
      color: colors.accentForeground,
      lineHeight: 19,
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      borderRadius: colors.radius,
      paddingVertical: 15,
      alignItems: 'center',
      marginBottom: 10,
    },
    primaryBtnText: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.primaryForeground,
    },
    secondaryBtn: {
      backgroundColor: 'transparent',
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 13,
      alignItems: 'center',
    },
    secondaryBtnText: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.foreground,
    },
    btnDisabled: {
      opacity: 0.6,
    },
  });
}
