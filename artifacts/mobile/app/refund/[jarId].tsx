/**
 * Refund Request Screen — Phase 4C
 *
 * Allows a jar member to request a principal refund (FIFO Stripe-only lots):
 *   1. Fetch refund preview (GET /jars/:jarId/refunds/preview)
 *      — returns maxRefundableCents + available lot breakdown
 *   2. Amount input pre-filled with max, user can edit down (partial refund)
 *   3. User submits → POST /jars/:jarId/refunds
 *   4. Success state: shows refund request ID and status
 *
 * Architecture decisions (D4):
 *   - Pre-filled editable input — partial refunds are first-class (D4)
 *   - Input is bounded: min $1, max = maxRefundableCents
 *   - "Refundable" means contributed via Stripe AND not yet committed
 */

import React, { useState, useCallback, useEffect } from 'react';
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
import { CurrencyInput } from '@/components/CurrencyInput';
import { customFetch } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RefundLot {
  sourceFtId: string;
  refundableCents: number;
  currency: string;
}

interface RefundPreview {
  maxRefundableCents: number;
  currency: string;
  lots: RefundLot[];
}

interface RefundCreateResult {
  refundRequestId: string;
  status: string;
  requestedCents: number;
  currency: string;
  allocations: { id: string; allocatedCents: number; providerStatus: string }[];
}

type FlowStep = 'loading' | 'input' | 'submitting' | 'success' | 'error' | 'unavailable';

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

export default function RefundScreen() {
  const { jarId } = useLocalSearchParams<{ jarId: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<FlowStep>('loading');
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [amountCents, setAmountCents] = useState(0);
  const [result, setResult] = useState<RefundCreateResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [unavailableReason, setUnavailableReason] = useState('');

  // ─── Load preview ────────────────────────────────────────────────────────

  const fetchPreview = useCallback(async () => {
    setStep('loading');
    setErrorMessage('');
    try {
      const data = await customFetch<RefundPreview>(
        `/api/jars/${jarId}/refunds/preview`,
      );
      setPreview(data);
      // Pre-fill with max refundable amount
      setAmountCents(data.maxRefundableCents);
      setStep('input');
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string; message?: string } };
      const apiError = e?.body?.error ?? '';
      const apiMsg = e?.body?.message ?? '';

      if (
        // The refund route no longer has a jar-status gate at all, so it cannot
        // return `JarLifecycle` — deliberately not listed here. What it can now
        // return is `NoRefundableBalance`, introduced when the status gate was
        // removed; without this the screen fell through to a generic error.
        apiError === 'NoRefundableBalance' ||
        apiError === 'PhaseGate' ||
        apiError === 'NothingToRefund' ||
        apiError === 'NoRefundableFunds'
      ) {
        setUnavailableReason(apiMsg || 'No refundable funds are available at this time.');
        setStep('unavailable');
      } else {
        setErrorMessage(apiMsg || 'Could not load refund preview. Please try again.');
        setStep('error');
      }
    }
  }, [jarId]);

  useEffect(() => {
    void fetchPreview();
  }, [fetchPreview]);

  // ─── Submit refund request ────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!preview || amountCents <= 0) return;

    if (amountCents > preview.maxRefundableCents) {
      Alert.alert('Amount too large', `You can refund at most ${formatDollars(preview.maxRefundableCents, preview.currency)}.`);
      return;
    }

    setStep('submitting');
    try {
      const data = await customFetch<RefundCreateResult>(
        `/api/jars/${jarId}/refunds`,
        {
          method: 'POST',
          body: JSON.stringify({ requestedCents: amountCents }),
        },
      );
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/activity`] });
      setStep('success');
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { error?: string; message?: string } };
      const apiMsg = e?.body?.message ?? 'Refund request failed. Please try again.';
      setErrorMessage(apiMsg);
      setStep('error');
    }
  };

  // ─── Render helpers ──────────────────────────────────────────────────────

  const s = makeStyles(colors, insets);

  const renderHeader = () => (
    <View style={s.header}>
      <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={12}>
        <Feather name="arrow-left" size={22} color={colors.foreground} />
      </Pressable>
      <Text style={s.headerTitle}>Request Refund</Text>
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
          <Text style={s.loadingText}>Checking refundable funds…</Text>
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
            <Feather name="dollar-sign" size={28} color={colors.mutedForeground} />
          </View>
          <Text style={s.unavailableTitle}>No Refundable Funds</Text>
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

  if (step === 'success' && result) {
    return (
      <View style={s.screen}>
        {renderHeader()}
        <View style={s.centeredContent}>
          <View style={[s.iconCircle, { backgroundColor: '#DCFCE7' }]}>
            <Feather name="check-circle" size={32} color={colors.success} />
          </View>
          <Text style={s.successTitle}>Refund Requested</Text>
          <Text style={s.successAmount}>
            {formatDollars(result.requestedCents, result.currency)}
          </Text>
          <Text style={s.successSubtitle}>
            Your refund request has been received. Funds are typically returned within 5–10
            business days, depending on your payment provider.
          </Text>
          <View style={s.refundIdBox}>
            <Text style={s.refundIdLabel}>Request ID</Text>
            <Text style={s.refundIdValue} numberOfLines={1}>{result.refundRequestId.slice(-12)}</Text>
          </View>
          <Pressable style={s.primaryBtn} onPress={() => router.back()}>
            <Text style={s.primaryBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Input (default) ──────────────────────────────────────────────────────

  if (!preview) return null;

  const isSubmitting = step === 'submitting';
  const isPartial = amountCents < preview.maxRefundableCents && amountCents > 0;
  const canSubmit = amountCents > 0 && amountCents <= preview.maxRefundableCents;

  return (
    <View style={s.screen}>
      {renderHeader()}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Max available */}
        <View style={s.availableCard}>
          <Text style={s.availableLabel}>Available to refund</Text>
          <Text style={s.availableAmount}>
            {formatDollars(preview.maxRefundableCents, preview.currency)}
          </Text>
          <Text style={s.availableSub}>
            {preview.lots.length} contribution{preview.lots.length !== 1 ? 's' : ''} ·{' '}
            Stripe-only, FIFO order
          </Text>
        </View>

        {/* Amount input */}
        <Text style={s.inputLabel}>Refund amount</Text>
        <CurrencyInput
          value={amountCents}
          onChangeCents={setAmountCents}
          error={
            amountCents > preview.maxRefundableCents
              ? `Maximum refundable is ${formatDollars(preview.maxRefundableCents, preview.currency)}`
              : undefined
          }
        />

        {/* Partial refund note */}
        {isPartial && (
          <View style={s.partialBadge}>
            <Feather name="scissors" size={12} color={colors.warning} />
            <Text style={s.partialText}>
              Partial refund — {formatDollars(preview.maxRefundableCents - amountCents, preview.currency)} will remain refundable
            </Text>
          </View>
        )}

        {/* Lots breakdown */}
        {preview.lots.length > 0 && (
          <>
            <Text style={s.sectionTitle}>Contribution lots (FIFO)</Text>
            {preview.lots.map((lot, idx) => (
              <View key={lot.sourceFtId} style={s.lotRow}>
                <View style={s.lotIndex}>
                  <Text style={s.lotIndexText}>{idx + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.lotAmount}>
                    {formatDollars(lot.refundableCents, lot.currency)}
                  </Text>
                  <Text style={s.lotId} numberOfLines={1}>
                    txn: {lot.sourceFtId.slice(-8)}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}

        {/* Info box */}
        <View style={s.infoBox}>
          <Feather name="info" size={14} color={colors.accentForeground} style={{ marginTop: 1 }} />
          <Text style={s.infoText}>
            Only funds contributed via Stripe that haven't been committed to the jar's goal are
            eligible for refund. Processing times depend on your payment provider (typically 5–10
            business days).
          </Text>
        </View>

        {/* Submit */}
        <Pressable
          style={[s.primaryBtn, (!canSubmit || isSubmitting) && s.btnDisabled]}
          onPress={() => void handleSubmit()}
          disabled={!canSubmit || isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={s.primaryBtnText}>
              Request {amountCents > 0 ? formatDollars(amountCents, preview.currency) : ''} Refund
            </Text>
          )}
        </Pressable>

        <Pressable style={s.secondaryBtn} onPress={() => router.back()} disabled={isSubmitting}>
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
      marginBottom: 20,
    },
    refundIdBox: {
      backgroundColor: colors.muted,
      borderRadius: colors.radius - 4,
      paddingHorizontal: 16,
      paddingVertical: 10,
      width: '100%',
      marginBottom: 28,
    },
    refundIdLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      marginBottom: 2,
    },
    refundIdValue: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.foreground,
      fontVariant: ['tabular-nums'],
    },
    availableCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      padding: 20,
      marginBottom: 20,
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    availableLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      marginBottom: 4,
    },
    availableAmount: {
      fontSize: 32,
      fontWeight: '800',
      color: colors.foreground,
      marginBottom: 6,
    },
    availableSub: {
      fontSize: 12,
      color: colors.mutedForeground,
    },
    inputLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.foreground,
      marginBottom: 8,
    },
    partialBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: '#FEF9C3',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 10,
    },
    partialText: {
      fontSize: 12,
      color: colors.warning,
      flex: 1,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 20,
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
      opacity: 0.5,
    },
  });
}
