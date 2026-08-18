/**
 * AutoDrip Setup Screen — Phase 4E
 * Route: /jar/[id]/autodrip/setup  (Expo Router: app/jar/[id]/autodrip/setup.tsx)
 *
 * Multi-step wizard to configure and enable AutoDrip:
 *   Step 1: Choose amount + frequency
 *   Step 2: Choose saved payment method (or add new via /payment-methods)
 *   Step 3: Fee preview + explicit consent checkbox
 *   Step 4: Success confirmation
 *
 * Security invariants:
 *   - fee amounts are fetched from server (POST /jars/:jarId/autodrip/preview)
 *   - client never computes or submits fee amounts
 *   - consent must be true; server-side guard as well
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
  Platform,
  Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { CurrencyInput } from '@/components/CurrencyInput';
import { customFetch } from '@workspace/api-client-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'twiceMonthly';
type Step = 'amount' | 'payment' | 'review' | 'success';

interface SavedPaymentMethod {
  id: string;
  type: string;
  displayBrand: string | null;
  last4: string | null;
  bankName: string | null;
  isDefault: boolean;
  status: string;
}

interface Preview {
  principalCents: number;
  dripJarFeeCents: number;
  processingFeeCents: number;
  totalChargeCents: number;
  nextRunAt: string;
  scheduleTotalCents: number;
  contributedPrincipalCents: number;
  remainingExpectedPrincipalCents: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FREQUENCIES: { value: Frequency; label: string; sub: string }[] = [
  { value: 'weekly', label: 'Weekly', sub: 'Every week' },
  { value: 'biweekly', label: 'Every 2 Weeks', sub: 'Twice a month (biweekly)' },
  { value: 'monthly', label: 'Monthly', sub: 'Once a month' },
  { value: 'twiceMonthly', label: 'Twice Monthly', sub: '1st and 15th' },
];

function fmt(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function pmLabel(pm: SavedPaymentMethod): string {
  if (pm.type === 'card') return `${pm.displayBrand ?? 'Card'} •••• ${pm.last4 ?? '----'}`;
  return `${pm.bankName ?? 'Bank'} •••• ${pm.last4 ?? '----'}`;
}

function pmIcon(pm: SavedPaymentMethod): React.ComponentProps<typeof Feather>['name'] {
  return pm.type === 'card' ? 'credit-card' : 'dollar-sign';
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AutoDripSetupScreen() {
  const { id: jarId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Wizard state
  const [step, setStep] = useState<Step>('amount');
  const [principalCents, setPrincipalCents] = useState(5000); // $50 default
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [methods, setMethods] = useState<SavedPaymentMethod[]>([]);
  const [selectedPmId, setSelectedPmId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load saved payment methods when reaching payment step
  const loadMethods = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<SavedPaymentMethod[]>('/api/payment-methods');
      const active = (Array.isArray(data) ? data : []).filter(m => m.status === 'active');
      setMethods(active);
      // Auto-select default
      const def = active.find(m => m.isDefault) ?? active[0];
      if (def) setSelectedPmId(def.id);
    } catch {
      setError('Failed to load payment methods.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === 'payment') void loadMethods();
  }, [step, loadMethods]);

  // Fetch preview when reaching review step
  const loadPreview = useCallback(async () => {
    if (!selectedPmId) return;
    setLoading(true);
    setError('');
    try {
      const data = await customFetch<Preview>(`/api/jars/${jarId}/autodrip/preview`, {
        method: 'POST',
        body: JSON.stringify({ principalCents, frequency, paymentMethodId: selectedPmId }),
      });
      setPreview(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch fee preview');
    } finally {
      setLoading(false);
    }
  }, [jarId, principalCents, frequency, selectedPmId]);

  useEffect(() => {
    if (step === 'review') void loadPreview();
  }, [step, loadPreview]);

  const handleEnable = async () => {
    if (!selectedPmId || !consent) return;
    setLoading(true);
    setError('');
    try {
      await customFetch(`/api/jars/${jarId}/autodrip`, {
        method: 'POST',
        body: JSON.stringify({ principalCents, frequency, paymentMethodId: selectedPmId, consentGiven: true }),
      });
      setStep('success');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to enable AutoDrip');
    } finally {
      setLoading(false);
    }
  };

  const stepIndex = { amount: 0, payment: 1, review: 2, success: 3 };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable
          onPress={() => {
            if (step === 'amount' || step === 'success') router.back();
            else {
              const prev: Record<Step, Step> = { amount: 'amount', payment: 'amount', review: 'payment', success: 'review' };
              setStep(prev[step]);
            }
          }}
          style={styles.backBtn}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Set Up AutoDrip</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Progress bar */}
      {step !== 'success' && (
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
          <View
            style={[styles.progressFill, { backgroundColor: colors.primary, width: `${((stepIndex[step] + 1) / 3) * 100}%` }]}
          />
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Step 1: Amount + Frequency ─────────────────────────────────── */}
        {step === 'amount' && (
          <View style={styles.stepSection}>
            <Text style={[styles.stepTitle, { color: colors.foreground }]}>How much per Drip?</Text>
            <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>
              This is the principal amount DripJar will charge automatically each time.
            </Text>

            <CurrencyInput
              value={principalCents}
              onChangeCents={setPrincipalCents}
              label="Amount per Drip"
            />

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>FREQUENCY</Text>
            {FREQUENCIES.map(f => (
              <Pressable
                key={f.value}
                onPress={() => setFrequency(f.value)}
                style={[
                  styles.freqOption,
                  {
                    backgroundColor: frequency === f.value ? colors.primary + '10' : colors.card,
                    borderColor: frequency === f.value ? colors.primary : colors.border,
                  },
                ]}
              >
                <View style={styles.freqRadio}>
                  {frequency === f.value && <View style={[styles.freqRadioDot, { backgroundColor: colors.primary }]} />}
                </View>
                <View style={styles.freqInfo}>
                  <Text style={[styles.freqLabel, { color: colors.foreground }]}>{f.label}</Text>
                  <Text style={[styles.freqSub, { color: colors.mutedForeground }]}>{f.sub}</Text>
                </View>
              </Pressable>
            ))}

            <Pressable
              onPress={() => principalCents >= 100 ? setStep('payment') : Alert.alert('Minimum $1.00', 'AutoDrip amount must be at least $1.00')}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.primaryBtnText}>Next: Choose Payment Method</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </Pressable>
          </View>
        )}

        {/* ── Step 2: Payment method ─────────────────────────────────────── */}
        {step === 'payment' && (
          <View style={styles.stepSection}>
            <Text style={[styles.stepTitle, { color: colors.foreground }]}>Payment Method</Text>
            <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>
              Choose the saved payment method DripJar will charge for each AutoDrip.
            </Text>

            {loading ? (
              <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
            ) : methods.length === 0 ? (
              <View style={styles.noPmSection}>
                <Feather name="credit-card" size={36} color={colors.mutedForeground} />
                <Text style={[styles.noPmText, { color: colors.mutedForeground }]}>
                  No saved payment methods. Add one to continue.
                </Text>
                <Pressable
                  onPress={() => router.push(`/jar/${jarId}/payment-methods` as never)}
                  style={[styles.outlineBtn, { borderColor: colors.primary }]}
                >
                  <Feather name="plus" size={16} color={colors.primary} />
                  <Text style={[styles.outlineBtnText, { color: colors.primary }]}>Add Payment Method</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {methods.map(pm => (
                  <Pressable
                    key={pm.id}
                    onPress={() => setSelectedPmId(pm.id)}
                    style={[
                      styles.pmOption,
                      {
                        backgroundColor: selectedPmId === pm.id ? colors.primary + '10' : colors.card,
                        borderColor: selectedPmId === pm.id ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <View style={styles.freqRadio}>
                      {selectedPmId === pm.id && <View style={[styles.freqRadioDot, { backgroundColor: colors.primary }]} />}
                    </View>
                    <Feather name={pmIcon(pm)} size={20} color={colors.primary} style={styles.pmIcon} />
                    <View style={styles.pmInfo}>
                      <Text style={[styles.pmLabel, { color: colors.foreground }]}>{pmLabel(pm)}</Text>
                      {pm.isDefault && <Text style={[styles.pmDefaultTag, { color: colors.primary }]}>Default</Text>}
                    </View>
                  </Pressable>
                ))}

                <Pressable
                  onPress={() => router.push(`/jar/${jarId}/payment-methods` as never)}
                  style={[styles.outlineBtn, { borderColor: colors.border }]}
                >
                  <Feather name="plus" size={16} color={colors.foreground} />
                  <Text style={[styles.outlineBtnText, { color: colors.foreground }]}>Add Payment Method</Text>
                </Pressable>

                <Pressable
                  onPress={() => selectedPmId ? setStep('review') : Alert.alert('Select a payment method', 'Please choose a payment method to continue.')}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={styles.primaryBtnText}>Next: Review & Authorize</Text>
                  <Feather name="arrow-right" size={18} color="#fff" />
                </Pressable>
              </>
            )}
          </View>
        )}

        {/* ── Step 3: Review + Consent ───────────────────────────────────── */}
        {step === 'review' && (
          <View style={styles.stepSection}>
            <Text style={[styles.stepTitle, { color: colors.foreground }]}>Review & Authorize</Text>
            <Text style={[styles.stepSub, { color: colors.mutedForeground }]}>
              Review your AutoDrip settings and authorize DripJar to charge your payment method.
            </Text>

            {loading && !preview ? (
              <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
            ) : error ? (
              <Text style={[styles.errorText, { color: '#DC2626' }]}>{error}</Text>
            ) : preview ? (
              <>
                <View style={[styles.feeCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.feeRow}>
                    <Text style={[styles.feeLabel, { color: colors.mutedForeground }]}>Amount per Drip</Text>
                    <Text style={[styles.feeValue, { color: colors.foreground }]}>{fmt(preview.principalCents)}</Text>
                  </View>
                  <View style={[styles.feeDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.feeRow}>
                    <Text style={[styles.feeLabel, { color: colors.mutedForeground }]}>DripJar fee (3%)</Text>
                    <Text style={[styles.feeValue, { color: colors.foreground }]}>{fmt(preview.dripJarFeeCents)}</Text>
                  </View>
                  <View style={styles.feeRow}>
                    <Text style={[styles.feeLabel, { color: colors.mutedForeground }]}>Processing fee (est.)</Text>
                    <Text style={[styles.feeValue, { color: colors.foreground }]}>{fmt(preview.processingFeeCents)}</Text>
                  </View>
                  <View style={[styles.feeDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.feeRow}>
                    <Text style={[styles.feeTotalLabel, { color: colors.foreground }]}>Total per Drip</Text>
                    <Text style={[styles.feeTotalValue, { color: colors.primary }]}>{fmt(preview.totalChargeCents)}</Text>
                  </View>
                </View>

                <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.infoCardRow}>
                    <Text style={[styles.infoCardLabel, { color: colors.mutedForeground }]}>Frequency</Text>
                    <Text style={[styles.infoCardValue, { color: colors.foreground }]}>{FREQUENCIES.find(f => f.value === frequency)?.label}</Text>
                  </View>
                  <View style={styles.infoCardRow}>
                    <Text style={[styles.infoCardLabel, { color: colors.mutedForeground }]}>First Drip</Text>
                    <Text style={[styles.infoCardValue, { color: colors.foreground }]}>{fmtDate(preview.nextRunAt)}</Text>
                  </View>
                  <View style={styles.infoCardRow}>
                    <Text style={[styles.infoCardLabel, { color: colors.mutedForeground }]}>Remaining to save</Text>
                    <Text style={[styles.infoCardValue, { color: colors.foreground }]}>{fmt(preview.remainingExpectedPrincipalCents)}</Text>
                  </View>
                </View>

                {/* Consent */}
                <Pressable onPress={() => setConsent(c => !c)} style={styles.consentRow}>
                  <Switch
                    value={consent}
                    onValueChange={setConsent}
                    trackColor={{ true: colors.primary }}
                    thumbColor="#fff"
                  />
                  <Text style={[styles.consentText, { color: colors.foreground }]}>
                    I authorize DripJar to automatically charge{' '}
                    <Text style={{ fontWeight: '700' }}>{fmt(preview.totalChargeCents)}</Text> to my
                    saved payment method on the selected schedule until my contribution goal is met,
                    or until I cancel.
                  </Text>
                </Pressable>

                {error ? <Text style={[styles.errorText, { color: '#DC2626' }]}>{error}</Text> : null}

                <Pressable
                  onPress={handleEnable}
                  disabled={!consent || loading}
                  style={[styles.primaryBtn, { backgroundColor: consent ? colors.primary : colors.mutedForeground }]}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Feather name="zap" size={18} color="#fff" />
                      <Text style={styles.primaryBtnText}>Enable AutoDrip</Text>
                    </>
                  )}
                </Pressable>
              </>
            ) : null}
          </View>
        )}

        {/* ── Step 4: Success ───────────────────────────────────────────── */}
        {step === 'success' && (
          <View style={styles.successSection}>
            <View style={[styles.successIcon, { backgroundColor: colors.primary + '20' }]}>
              <Feather name="check-circle" size={48} color={colors.primary} />
            </View>
            <Text style={[styles.successTitle, { color: colors.foreground }]}>AutoDrip is On! 🎉</Text>
            <Text style={[styles.successBody, { color: colors.mutedForeground }]}>
              DripJar will automatically Drip on your schedule. You can pause, update, or cancel AutoDrip at any time.
            </Text>
            <Pressable
              onPress={() => router.replace(`/jar/${jarId}/autodrip` as never)}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.primaryBtnText}>View AutoDrip Status</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  progressBar: { height: 4, width: '100%' },
  progressFill: { height: 4 },
  content: { padding: 20, paddingBottom: 48 },
  stepSection: { gap: 16 },
  stepTitle: { fontSize: 22, fontWeight: '700' },
  stepSub: { fontSize: 15, lineHeight: 22 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginTop: 4 },
  freqOption: { flexDirection: 'row', alignItems: 'center', padding: 14, borderWidth: 1.5, borderRadius: 12, gap: 12 },
  freqRadio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#D1D5DB', alignItems: 'center', justifyContent: 'center' },
  freqRadioDot: { width: 10, height: 10, borderRadius: 5 },
  freqInfo: { flex: 1 },
  freqLabel: { fontSize: 15, fontWeight: '600' },
  freqSub: { fontSize: 13, marginTop: 2 },
  pmOption: { flexDirection: 'row', alignItems: 'center', padding: 14, borderWidth: 1.5, borderRadius: 12, gap: 10 },
  pmIcon: { marginRight: 2 },
  pmInfo: { flex: 1 },
  pmLabel: { fontSize: 15, fontWeight: '600' },
  pmDefaultTag: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  noPmSection: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  noPmText: { fontSize: 15, textAlign: 'center' },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13, borderWidth: 1.5, borderRadius: 12, justifyContent: 'center' },
  outlineBtnText: { fontSize: 15, fontWeight: '600' },
  loader: { paddingVertical: 24 },
  feeCard: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 12 },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  feeDivider: { height: 1 },
  feeLabel: { fontSize: 14 },
  feeValue: { fontSize: 14, fontWeight: '600' },
  feeTotalLabel: { fontSize: 15, fontWeight: '700' },
  feeTotalValue: { fontSize: 17, fontWeight: '800' },
  infoCard: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
  infoCardRow: { flexDirection: 'row', justifyContent: 'space-between' },
  infoCardLabel: { fontSize: 14 },
  infoCardValue: { fontSize: 14, fontWeight: '600' },
  consentRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  consentText: { flex: 1, fontSize: 14, lineHeight: 22 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 15, borderRadius: 12 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  errorText: { fontSize: 14 },
  successSection: { alignItems: 'center', gap: 16, paddingVertical: 32 },
  successIcon: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  successTitle: { fontSize: 24, fontWeight: '800' },
  successBody: { fontSize: 15, textAlign: 'center', lineHeight: 22, maxWidth: 300 },
});
