/**
 * Saved Payment Methods Screen — Phase 4E
 * Route: /jar/[id]/payment-methods  (Expo Router: app/jar/[id]/payment-methods.tsx)
 *
 * Lets a contributor manage their saved payment methods used for AutoDrip.
 * Organizers do not reach this screen (navigation guarded by jar/[id].tsx).
 *
 * Features:
 *   - List saved methods (card + ACH), mark default
 *   - Add card or ACH via Stripe PaymentSheet (SetupIntent)
 *   - Remove a saved method (409 if referenced by active AutoDrip)
 *   - Pending verification badge for ACH awaiting micro-deposit
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
import { useQueryClient } from '@tanstack/react-query';
import { StripeProvider, useStripe } from '@stripe/stripe-react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SavedPaymentMethod {
  id: string;
  type: 'card' | 'us_bank_account';
  displayBrand: string | null;
  last4: string | null;
  bankName: string | null;
  isDefault: boolean;
  status: 'active' | 'pending_verification' | 'detached';
  createdAt: string;
}

// ─── Publishable key guard ────────────────────────────────────────────────────

const RAW_PK = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
const pkValid = RAW_PK.startsWith('pk_test_');

// ─── Sub-components ───────────────────────────────────────────────────────────

function PaymentMethodCard({
  method,
  onSetDefault,
  onRemove,
  removing,
}: {
  method: SavedPaymentMethod;
  onSetDefault: (id: string) => void;
  onRemove: (id: string) => void;
  removing: string | null;
}) {
  const colors = useColors();
  const isCard = method.type === 'card';

  const label = isCard
    ? `${(method.displayBrand ?? 'Card').charAt(0).toUpperCase() + (method.displayBrand ?? 'Card').slice(1)} •••• ${method.last4 ?? '----'}`
    : `${method.bankName ?? 'Bank'} •••• ${method.last4 ?? '----'}`;

  const icon: React.ComponentProps<typeof Feather>['name'] = isCard ? 'credit-card' : 'dollar-sign';

  return (
    <View
      style={[
        styles.methodCard,
        { backgroundColor: colors.card, borderColor: method.isDefault ? colors.primary : colors.border },
      ]}
    >
      <View style={styles.methodRow}>
        <Feather name={icon} size={20} color={colors.primary} style={styles.methodIcon} />
        <View style={styles.methodInfo}>
          <Text style={[styles.methodLabel, { color: colors.foreground }]}>{label}</Text>
          <View style={styles.badgeRow}>
            {method.isDefault && (
              <View style={[styles.badge, { backgroundColor: colors.primary + '20' }]}>
                <Text style={[styles.badgeText, { color: colors.primary }]}>Default</Text>
              </View>
            )}
            {method.status === 'pending_verification' && (
              <View style={[styles.badge, { backgroundColor: '#FEF3C7' }]}>
                <Text style={[styles.badgeText, { color: '#B45309' }]}>Pending verification</Text>
              </View>
            )}
          </View>
        </View>
      </View>
      <View style={styles.methodActions}>
        {!method.isDefault && method.status === 'active' && (
          <Pressable onPress={() => onSetDefault(method.id)} style={styles.actionBtn}>
            <Text style={[styles.actionBtnText, { color: colors.primary }]}>Set default</Text>
          </Pressable>
        )}
        {removing === method.id ? (
          <ActivityIndicator size="small" color={colors.destructive} />
        ) : (
          <Pressable onPress={() => onRemove(method.id)} style={styles.actionBtn}>
            <Feather name="trash-2" size={16} color={colors.destructive ?? '#DC2626'} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

function PaymentMethodsContent() {
  const { id: jarId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();

  const [methods, setMethods] = useState<SavedPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<'card' | 'us_bank_account' | null>(null);

  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const fetchMethods = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const data = await customFetch<SavedPaymentMethod[]>('/payment-methods');
      setMethods(Array.isArray(data) ? data : []);
    } catch {
      // keep existing
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { void fetchMethods(); }, [fetchMethods]);

  const handleSetDefault = async (id: string) => {
    try {
      await customFetch(`/payment-methods/${id}/default`, { method: 'POST' });
      await fetchMethods();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to set default';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    }
  };

  const handleRemove = (id: string) => {
    const confirm = () => {
      void doRemove(id);
    };
    const method = methods.find(m => m.id === id);
    const label = method?.type === 'card'
      ? `${method.displayBrand ?? 'card'} ••${method.last4 ?? ''}`
      : `bank account ••${method?.last4 ?? ''}`;

    if (Platform.OS === 'web') {
      if (window.confirm(`Remove ${label}? This cannot be undone.`)) confirm();
    } else {
      Alert.alert('Remove Payment Method', `Remove ${label}? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: confirm },
      ]);
    }
  };

  const doRemove = async (id: string) => {
    setRemoving(id);
    try {
      await customFetch(`/payment-methods/${id}`, { method: 'DELETE' });
      setMethods(prev => prev.filter(m => m.id !== id));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to remove';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    } finally {
      setRemoving(null);
    }
  };

  const handleAddMethod = async (type: 'card' | 'us_bank_account') => {
    if (!pkValid) {
      Alert.alert('Configuration Error', 'Stripe test key not configured');
      return;
    }
    setAddingType(type);
    try {
      // 1. Create SetupIntent
      const { setupIntentId, clientSecret } = await customFetch<{ setupIntentId: string; clientSecret: string }>(
        '/payment-methods/setup',
        { method: 'POST', body: JSON.stringify({ type }) },
      );

      // 2. Init PaymentSheet in setup mode
      const { error: initError } = await initPaymentSheet({
        setupIntentClientSecret: clientSecret,
        merchantDisplayName: 'DripJar',
        allowsDelayedPaymentMethods: type === 'us_bank_account',
      });
      if (initError) throw new Error(initError.message);

      // 3. Present
      const { error: presentError } = await presentPaymentSheet();
      if (presentError) {
        if (presentError.code !== 'Canceled') throw new Error(presentError.message);
        return;
      }

      // 4. Confirm with backend
      const saved = await customFetch<SavedPaymentMethod>('/payment-methods/setup-confirm', {
        method: 'POST',
        body: JSON.stringify({ setupIntentId }),
      });

      setMethods(prev => {
        const exists = prev.some(m => m.id === saved.id);
        return exists ? prev.map(m => m.id === saved.id ? saved : m) : [...prev, saved];
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add payment method';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    } finally {
      setAddingType(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Payment Methods</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void fetchMethods(true); }} />}
      >
        {methods.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="credit-card" size={40} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No saved payment methods</Text>
            <Text style={[styles.emptySubtext, { color: colors.mutedForeground }]}>
              Add a card or bank account to use AutoDrip.
            </Text>
          </View>
        ) : (
          methods.map(m => (
            <PaymentMethodCard
              key={m.id}
              method={m}
              onSetDefault={handleSetDefault}
              onRemove={handleRemove}
              removing={removing}
            />
          ))
        )}

        {/* Add buttons */}
        <View style={styles.addSection}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>ADD PAYMENT METHOD</Text>
          <Pressable
            onPress={() => handleAddMethod('card')}
            disabled={addingType !== null}
            style={[styles.addBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            {addingType === 'card' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="credit-card" size={18} color={colors.primary} />
            )}
            <Text style={[styles.addBtnText, { color: colors.foreground }]}>Add Card</Text>
          </Pressable>
          <Pressable
            onPress={() => handleAddMethod('us_bank_account')}
            disabled={addingType !== null}
            style={[styles.addBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            {addingType === 'us_bank_account' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="dollar-sign" size={18} color={colors.primary} />
            )}
            <Text style={[styles.addBtnText, { color: colors.foreground }]}>Add Bank Account (ACH)</Text>
          </Pressable>
          <Text style={[styles.achNote, { color: colors.mutedForeground }]}>
            ACH bank accounts require verification via micro-deposits (1–2 business days) before they can be used for AutoDrip.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

export default function PaymentMethodsScreen() {
  if (!pkValid) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#DC2626', textAlign: 'center' }}>
          Stripe test key not configured. Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY (pk_test_…).
        </Text>
      </View>
    );
  }
  return (
    <StripeProvider publishableKey={RAW_PK}>
      <PaymentMethodsContent />
    </StripeProvider>
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
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  methodCard: { borderWidth: 1.5, borderRadius: 14, padding: 14, gap: 8 },
  methodRow: { flexDirection: 'row', alignItems: 'center' },
  methodIcon: { marginRight: 12 },
  methodInfo: { flex: 1, gap: 4 },
  methodLabel: { fontSize: 15, fontWeight: '600' },
  badgeRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  methodActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12 },
  actionBtn: { padding: 4 },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  addSection: { marginTop: 8, gap: 10 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  addBtnText: { fontSize: 15, fontWeight: '600' },
  achNote: { fontSize: 12, lineHeight: 18 },
  empty: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  emptyText: { fontSize: 17, fontWeight: '600' },
  emptySubtext: { fontSize: 14, textAlign: 'center' },
});
