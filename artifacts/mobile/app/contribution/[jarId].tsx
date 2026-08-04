/**
 * Add Funds Screen — Phase 4B
 *
 * Stripe test-mode drip payment flow:
 *   1. User enters principal amount
 *   2. User selects payment method (ACH or Card)
 *   3. Fetch persisted quote → show fee breakdown confirmation
 *   4. User confirms → POST /jars/:jarId/drips/payment-intent → clientSecret
 *   5. Init + present Stripe PaymentSheet
 *   6. After PaymentSheet returns → show "Your Drip is processing."
 *   7. Poll status until succeeded or failed
 *   8. On success → show "Funds Added!" and invalidate queries
 *
 * Security invariants:
 *   - EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with 'pk_test_'
 *   - pk_live_ keys or missing keys → config error, no payment UI rendered
 *   - Key value is never logged
 *   - Client never handles fee amounts or ledger state
 *   - "Funds Added!" is shown ONLY after server confirms providerStatus='succeeded'
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CurrencyInput } from '@/components/CurrencyInput';
import { useGetJar, customFetch } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { StripeProvider, useStripe } from '@stripe/stripe-react-native';

// ─── Publishable key guard ─────────────────────────────────────────────────────
// Validate BEFORE passing to StripeProvider.
// pk_live_ or missing key → fail safely with a config error.

const RAW_PK = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

function validatePublishableKey(key: string): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: 'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set.' };
  }
  if (key.startsWith('pk_live_')) {
    return {
      valid: false,
      error:
        'Live Stripe key detected. Only test-mode keys (pk_test_…) are permitted in this build.',
    };
  }
  if (!key.startsWith('pk_test_')) {
    return { valid: false, error: 'Invalid Stripe publishable key format.' };
  }
  return { valid: true };
}

const publishableKeyResult = validatePublishableKey(RAW_PK);

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentMethodType = 'us_bank_account' | 'card';
type FlowStep = 'amount' | 'payment_method' | 'review' | 'processing' | 'success' | 'failed';

interface PersistedQuote {
  financialTransactionId: string;
  principalCents: number;
  dripJarFeeCents: number;
  estimatedProcessingFeeCents: number;
  totalChargeCents: number;
  currency: string;
  paymentMethodType: PaymentMethodType;
  quoteExpiresAt: string;
}

// ─── Payment status polling ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 60; // 2 minutes max

function usePaymentStatusPoller(
  jarId: string,
  financialTransactionId: string | null,
  enabled: boolean,
  onSucceeded: () => void,
  onFailed: () => void,
) {
  const pollCount = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !financialTransactionId) return;

    pollCount.current = 0;

    const poll = async () => {
      if (pollCount.current >= MAX_POLLS) {
        onFailed();
        return;
      }
      pollCount.current += 1;

      try {
        const data = await customFetch<{ providerStatus: string }>(
          `/api/jars/${jarId}/drips/${financialTransactionId}/status`,
        );
        if (data.providerStatus === 'succeeded') {
          onSucceeded();
          return;
        }
        if (data.providerStatus === 'failed' || data.providerStatus === 'cancelled') {
          onFailed();
          return;
        }
      } catch {
        // Network errors or non-2xx — keep polling
      }

      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);

    return clearTimer;
  }, [enabled, financialTransactionId, jarId, onSucceeded, onFailed, clearTimer]);
}

// ─── Inner payment screen (requires StripeProvider context) ──────────────────

function AddContributionInner() {
  const { jarId } = useLocalSearchParams<{ jarId: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [amountCents, setAmountCents] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('us_bank_account');
  const [step, setStep] = useState<FlowStep>('amount');
  const [quote, setQuote] = useState<PersistedQuote | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeFtId, setActiveFtId] = useState<string | null>(null);

  const { data: jar } = useGetJar(jarId!);

  // Poll for payment status while in processing step
  usePaymentStatusPoller(
    jarId!,
    activeFtId,
    step === 'processing',
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['/api/jars'] });
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/activity`] });
      setStep('success');
    }, [queryClient, jarId]),
    useCallback(() => {
      setError('Payment failed or was cancelled. Please try again.');
      setStep('failed');
    }, []),
  );

  // ─── Step 1: Amount entered → go to payment method selection ──────────────

  const handleAmountNext = () => {
    if (amountCents <= 0) return;
    setStep('payment_method');
    setError('');
  };

  // ─── Step 2: Payment method selected → fetch quote ──────────────────────

  const handlePaymentMethodSelect = async (pmt: PaymentMethodType) => {
    setPaymentMethod(pmt);
    setError('');
    setIsLoading(true);

    try {
      const data = await customFetch<{
        financialTransactionId: string;
        principalCents: number;
        dripJarFeeCents: number;
        estimatedProcessingFeeCents: number;
        totalChargeCents: number;
        currency: string;
        paymentMethodType: string;
        quoteExpiresAt: string;
      }>('/api/finance/quote', {
        method: 'POST',
        body: JSON.stringify({
          principalCents: amountCents,
          paymentMethodType: pmt,
          jarId,
        }),
      });
      setQuote({
        financialTransactionId: data.financialTransactionId,
        principalCents: data.principalCents,
        dripJarFeeCents: data.dripJarFeeCents,
        estimatedProcessingFeeCents: data.estimatedProcessingFeeCents,
        totalChargeCents: data.totalChargeCents,
        currency: data.currency,
        paymentMethodType: pmt,
        quoteExpiresAt: data.quoteExpiresAt,
      });
      setStep('review');
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to get fee breakdown.');
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Step 3: User confirms review → create PI + launch PaymentSheet ───────

  const handleConfirmAndPay = async () => {
    if (!quote) return;
    setError('');
    setIsLoading(true);

    try {
      // Create PaymentIntent — auth is handled by customFetch (setAuthTokenGetter in auth-context)
      const piData = await customFetch<{
        clientSecret: string;
        customerSessionClientSecret?: string;
        financialTransactionId: string;
      }>(`/api/jars/${jarId}/drips/payment-intent`, {
        method: 'POST',
        body: JSON.stringify({ financialTransactionId: quote.financialTransactionId }),
      });
      const { clientSecret, customerSessionClientSecret } = piData;

      // Initialise PaymentSheet
      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: 'DripJar',
        paymentIntentClientSecret: clientSecret,
        ...(customerSessionClientSecret ? { customerSessionClientSecret } : {}),
        allowsDelayedPaymentMethods: true, // required for ACH
        defaultBillingDetails: {},
      });

      if (initError) {
        throw new Error(initError.message);
      }

      setIsLoading(false);

      // Present PaymentSheet
      const { error: presentError } = await presentPaymentSheet();

      if (presentError) {
        if (presentError.code === 'Canceled') {
          // User dismissed — stay on review
          return;
        }
        throw new Error(presentError.message);
      }

      // PaymentSheet returned without error → show processing state
      // (never show "Funds Added!" here — wait for webhook confirmation)
      setActiveFtId(quote.financialTransactionId);
      setStep('processing');
    } catch (e: unknown) {
      setIsLoading(false);
      setError((e as Error).message || 'Payment failed. Please try again.');
    }
  };

  // ─── Currency formatter ────────────────────────────────────────────────────

  const fmt = (cents: number) =>
    `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ─── Render: success ──────────────────────────────────────────────────────

  if (step === 'success') {
    return (
      <View style={[styles.container, { backgroundColor: colors.primary, paddingTop: insets.top }]}>
        <View style={styles.centeredContent}>
          <Feather name="check-circle" size={80} color="#fff" style={{ marginBottom: 24 }} />
          <Text style={styles.successTitle}>Funds Added!</Text>
          <Text style={styles.successSubtitle}>
            {fmt(quote?.principalCents ?? amountCents)} added to {jar?.name}.
            {'\n'}Your trip is one step closer.
          </Text>
        </View>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Pressable style={[styles.button, { backgroundColor: '#fff' }]} onPress={() => router.back()}>
            <Text style={[styles.buttonText, { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Render: processing ────────────────────────────────────────────────────

  if (step === 'processing') {
    return (
      <View
        style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.centeredContent}>
          <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: 24 }} />
          <Text style={[styles.processingTitle, { color: colors.foreground }]}>
            Your Drip is processing.
          </Text>
          <Text style={[styles.processingSubtitle, { color: colors.mutedForeground }]}>
            {quote?.paymentMethodType === 'us_bank_account'
              ? 'ACH bank transfers typically take 1–3 business days to settle.'
              : 'Confirming your payment…'}
          </Text>
        </View>
      </View>
    );
  }

  // ─── Render: failed ────────────────────────────────────────────────────────

  if (step === 'failed') {
    return (
      <View
        style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.centeredContent}>
          <Feather name="alert-circle" size={80} color={colors.destructive} style={{ marginBottom: 24 }} />
          <Text style={[styles.failedTitle, { color: colors.foreground }]}>Payment Failed</Text>
          <Text style={[styles.failedSubtitle, { color: colors.mutedForeground }]}>{error}</Text>
        </View>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => {
              setStep('amount');
              setQuote(null);
              setActiveFtId(null);
              setError('');
            }}>
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ─── Render: review (fee breakdown) ────────────────────────────────────────

  if (step === 'review' && quote) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.inner, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <Pressable onPress={() => setStep('payment_method')} style={styles.closeButton}>
              <Feather name="arrow-left" size={24} color={colors.foreground} />
            </Pressable>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Confirm Payment</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            <View style={[styles.breakdownCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.breakdownRow}>
                <Text style={[styles.breakdownLabel, { color: colors.foreground }]}>
                  Your Jar contribution
                </Text>
                <Text style={[styles.breakdownValue, { color: colors.foreground }]}>
                  {fmt(quote.principalCents)}
                </Text>
              </View>
              <View style={styles.breakdownRow}>
                <Text style={[styles.breakdownLabel, { color: colors.mutedForeground }]}>
                  DripJar service fee (3%)
                </Text>
                <Text style={[styles.breakdownValue, { color: colors.mutedForeground }]}>
                  {fmt(quote.dripJarFeeCents)}
                </Text>
              </View>
              <View style={styles.breakdownRow}>
                <Text style={[styles.breakdownLabel, { color: colors.mutedForeground }]}>
                  Payment processing
                  {quote.paymentMethodType === 'us_bank_account' ? ' (ACH)' : ' (Card)'}
                </Text>
                <Text style={[styles.breakdownValue, { color: colors.mutedForeground }]}>
                  {fmt(quote.estimatedProcessingFeeCents)}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.breakdownRow}>
                <Text style={[styles.breakdownLabelBold, { color: colors.foreground }]}>
                  Total charged
                </Text>
                <Text style={[styles.breakdownValueBold, { color: colors.foreground }]}>
                  {fmt(quote.totalChargeCents)}
                </Text>
              </View>
            </View>

            <Text style={[styles.disclosureText, { color: colors.mutedForeground }]}>
              {fmt(quote.principalCents)} is credited to the Jar only after payment succeeds.
              DripJar fee and processing fees are non-refundable. Your contribution is refundable
              until explicitly committed under Jar rules.
            </Text>

            {error ? (
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
            ) : null}
          </ScrollView>

          <View
            style={[
              styles.footer,
              {
                paddingBottom: Math.max(insets.bottom, 16),
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary, opacity: isLoading ? 0.7 : 1 }]}
              onPress={handleConfirmAndPay}
              disabled={isLoading}>
              {isLoading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                  Confirm and Pay
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ─── Render: payment method selection ────────────────────────────────────

  if (step === 'payment_method') {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.inner, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <Pressable onPress={() => setStep('amount')} style={styles.closeButton}>
              <Feather name="arrow-left" size={24} color={colors.foreground} />
            </Pressable>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Payment Method</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              How would you like to pay?
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Adding {fmt(amountCents)} to {jar?.name}
            </Text>

            {(['us_bank_account', 'card'] as PaymentMethodType[]).map((pmt) => (
              <Pressable
                key={pmt}
                style={[
                  styles.methodOption,
                  {
                    borderColor: paymentMethod === pmt ? colors.primary : colors.border,
                    backgroundColor:
                      paymentMethod === pmt ? colors.primary + '15' : colors.card,
                  },
                ]}
                onPress={() => setPaymentMethod(pmt)}
                disabled={isLoading}>
                <View style={styles.methodOptionContent}>
                  <Feather
                    name={pmt === 'us_bank_account' ? 'credit-card' : 'credit-card'}
                    size={20}
                    color={paymentMethod === pmt ? colors.primary : colors.mutedForeground}
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text
                      style={[
                        styles.methodTitle,
                        { color: paymentMethod === pmt ? colors.primary : colors.foreground },
                      ]}>
                      {pmt === 'us_bank_account' ? 'Bank Account (ACH — lower cost)' : 'Card (higher cost)'}
                    </Text>
                    <Text style={[styles.methodSubtitle, { color: colors.mutedForeground }]}>
                      {pmt === 'us_bank_account'
                        ? '0.8% fee, capped at $5.00'
                        : '2.9% + $0.30 fee'}
                    </Text>
                  </View>
                  {paymentMethod === pmt && (
                    <Feather name="check-circle" size={20} color={colors.primary} />
                  )}
                </View>
              </Pressable>
            ))}

            {error ? (
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
            ) : null}
          </ScrollView>

          <View
            style={[
              styles.footer,
              {
                paddingBottom: Math.max(insets.bottom, 16),
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}>
            <Pressable
              style={[
                styles.button,
                { backgroundColor: colors.primary, opacity: isLoading ? 0.7 : 1 },
              ]}
              onPress={() => handlePaymentMethodSelect(paymentMethod)}
              disabled={isLoading}>
              {isLoading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                  Continue
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ─── Render: amount entry ─────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.inner, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.closeButton}>
            <Feather name="x" size={24} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Add Funds</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.title, { color: colors.foreground }]}>How much are you adding?</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {jar?.name ? `Contributing to ${jar.name}` : ''}
          </Text>

          <View style={styles.inputWrapper}>
            <CurrencyInput
              value={amountCents}
              onChangeCents={setAmountCents}
              style={styles.largeInput}
              autoFocus
            />
          </View>

          {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              paddingBottom: Math.max(insets.bottom, 16),
              backgroundColor: colors.background,
              borderTopColor: colors.border,
            },
          ]}>
          <Pressable
            style={[
              styles.button,
              { backgroundColor: amountCents > 0 ? colors.primary : colors.muted },
            ]}
            onPress={handleAmountNext}
            disabled={amountCents <= 0}>
            <Text
              style={[
                styles.buttonText,
                {
                  color:
                    amountCents > 0 ? colors.primaryForeground : colors.mutedForeground,
                },
              ]}>
              Continue
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Root component: validates publishable key, wraps in StripeProvider ───────

export default function AddContributionScreen() {
  // Key validation result computed at module load time
  if (!publishableKeyResult.valid) {
    return <StripeConfigError message={publishableKeyResult.error!} />;
  }

  return (
    <StripeProvider publishableKey={RAW_PK} merchantIdentifier="merchant.com.dripjar">
      <AddContributionInner />
    </StripeProvider>
  );
}

// ─── Config error screen ────────────────────────────────────────────────────

function StripeConfigError({ message }: { message: string }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.centeredContent}>
        <Feather name="alert-triangle" size={64} color={colors.destructive} style={{ marginBottom: 16 }} />
        <Text style={[styles.failedTitle, { color: colors.foreground }]}>
          Payment Not Available
        </Text>
        <Text style={[styles.failedSubtitle, { color: colors.mutedForeground }]}>{message}</Text>
      </View>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Pressable
          style={[styles.button, { backgroundColor: colors.muted }]}
          onPress={() => router.back()}>
          <Text style={[styles.buttonText, { color: colors.mutedForeground }]}>Go Back</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  inner: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  closeButton: { width: 40, height: 40, justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  content: { padding: 24, paddingBottom: 40 },
  centeredContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: { fontSize: 28, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 16, marginBottom: 32, textAlign: 'center' },
  inputWrapper: { alignItems: 'center' },
  largeInput: { height: 80 },
  errorText: { fontSize: 14, textAlign: 'center', marginTop: 16 },
  footer: { paddingHorizontal: 24, paddingTop: 16, borderTopWidth: 1 },
  button: { height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 18, fontWeight: 'bold' },
  // Success
  successTitle: { fontSize: 32, fontWeight: 'bold', color: '#fff', marginBottom: 16, textAlign: 'center' },
  successSubtitle: { fontSize: 18, color: '#fff', textAlign: 'center', lineHeight: 26, opacity: 0.9 },
  // Processing
  processingTitle: { fontSize: 24, fontWeight: '600', marginBottom: 12, textAlign: 'center' },
  processingSubtitle: { fontSize: 16, textAlign: 'center', lineHeight: 22 },
  // Failed
  failedTitle: { fontSize: 28, fontWeight: 'bold', marginBottom: 12, textAlign: 'center' },
  failedSubtitle: { fontSize: 16, textAlign: 'center', lineHeight: 22 },
  // Payment method options
  methodOption: {
    borderWidth: 2,
    borderRadius: 12,
    marginBottom: 12,
    padding: 16,
  },
  methodOptionContent: { flexDirection: 'row', alignItems: 'center' },
  methodTitle: { fontSize: 16, fontWeight: '600' },
  methodSubtitle: { fontSize: 13, marginTop: 2 },
  // Fee breakdown card
  breakdownCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  breakdownLabel: { fontSize: 15 },
  breakdownValue: { fontSize: 15 },
  breakdownLabelBold: { fontSize: 16, fontWeight: '700' },
  breakdownValueBold: { fontSize: 16, fontWeight: '700' },
  divider: { height: 1, marginVertical: 8 },
  disclosureText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
});
