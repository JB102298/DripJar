import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CurrencyInput } from '@/components/CurrencyInput';
import { useCreateContribution, useGetJar, useQueryClient } from '@workspace/api-client-react';

export default function AddContributionScreen() {
  const { jarId } = useLocalSearchParams<{ jarId: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [amountCents, setAmountCents] = useState(0);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const { data: jar } = useGetJar(jarId!);
  const { mutateAsync: createContribution, isPending } = useCreateContribution();

  const handleSubmit = async () => {
    if (amountCents <= 0) return;
    try {
      setError('');
      await createContribution({
        data: {
          amountCents,
          contributionDate: new Date().toISOString(),
          // milestoneId and note could be added here
        }
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['/api/jars'] });
      queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/activity`] });

      setSuccess(true);
    } catch (e: any) {
      setError(e.message || 'Failed to add contribution.');
    }
  };

  const handleDone = () => {
    router.back();
  };

  if (success) {
    return (
      <View style={[styles.container, { backgroundColor: colors.primary, paddingTop: insets.top }]}>
        <View style={styles.successContent}>
          <Feather name="check-circle" size={80} color="#fff" style={{ marginBottom: 24 }} />
          <Text style={styles.successTitle}>Funds Added!</Text>
          <Text style={styles.successSubtitle}>
            ${(amountCents / 100).toLocaleString()} added to {jar?.name}. Your trip is one step closer.
          </Text>
        </View>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Pressable style={[styles.button, { backgroundColor: '#fff' }]} onPress={handleDone}>
            <Text style={[styles.buttonText, { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
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

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
          <Pressable
            style={[
              styles.button,
              { backgroundColor: amountCents > 0 ? colors.primary : colors.muted },
            ]}
            onPress={handleSubmit}
            disabled={amountCents <= 0 || isPending}
          >
            {isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.buttonText, { color: amountCents > 0 ? colors.primaryForeground : colors.mutedForeground }]}>
                Submit Contribution
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

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
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 16, marginBottom: 40, textAlign: 'center' },
  inputWrapper: {
    alignItems: 'center',
  },
  largeInput: {
    height: 80,
  },
  errorText: { fontSize: 14, textAlign: 'center', marginTop: 16 },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  button: {
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 18, fontWeight: 'bold' },
  successContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  successTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 16,
  },
  successSubtitle: {
    fontSize: 18,
    color: '#fff',
    textAlign: 'center',
    lineHeight: 26,
    opacity: 0.9,
  },
});
