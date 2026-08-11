/**
 * Saved Payment Methods — web fallback
 *
 * `@stripe/stripe-react-native` is a native-only module: it imports
 * `react-native/Libraries/Utilities/codegenNativeComponent`, which Metro
 * refuses to bundle for web. Because expo-router imports every file under
 * `app/`, a single native-only import in a route file breaks the *entire* web
 * bundle — not just the payment screens.
 *
 * This file is the `.web` half of a platform-specific pair. Metro resolves
 * `PaymentMethodsScreen.native.tsx` for iOS/Android and this file for web, so
 * no Stripe native code is ever reachable from the web bundle. The native
 * implementation is unchanged.
 *
 * Deliberately does NOT implement an alternative payment flow. Card and bank
 * collection must happen through Stripe's native PaymentSheet so that card
 * details never touch DripJar servers; re-implementing it on web would change
 * the compliance surface. This screen explains where to go instead.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

export default function PaymentMethodsScreenWeb() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={24} color={colors.foreground} />
          <Text style={[styles.backText, { color: colors.foreground }]}>Back</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.muted }]}>
          <Feather name="smartphone" size={28} color={colors.mutedForeground} />
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>
          Payment methods are managed in the mobile app
        </Text>

        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          Adding a card or bank account uses Stripe&apos;s secure payment sheet, which is
          only available in the DripJar iOS and Android apps. Your card details are entered
          directly with Stripe and never pass through DripJar.
        </Text>

        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          Open DripJar on your phone to add, remove, or change your default payment method.
          Everything else — your jars, goals, members, and balances — works here on the web.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, marginBottom: 8 },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  backText: { fontSize: 16, marginLeft: 4 },
  content: { paddingHorizontal: 24, alignItems: 'center', paddingTop: 32 },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 16,
    maxWidth: 460,
  },
});
