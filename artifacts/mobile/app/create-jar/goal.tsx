import React from 'react';
import { View, Text, StyleSheet, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { CurrencyInput } from '@/components/CurrencyInput';

export default function CreateJarStep3() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  const amountCents = state.goalAmountCents || 0;
  const isFormValid = amountCents > 0;

  const handleNext = () => {
    if (isFormValid) {
      router.push('/create-jar/milestones');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <View style={[styles.inner, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Feather name="arrow-left" size={24} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 3 of 8</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
          <ProgressBar progress={37.5} height={4} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.title, { color: colors.foreground }]}>What's your total goal?</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Don't worry if you don't know the exact amount yet. You can always adjust this later or break it down into milestones in the next step.
          </Text>

          <View style={styles.inputWrapper}>
            <CurrencyInput
              value={amountCents}
              onChangeCents={(cents) => updateState({ goalAmountCents: cents })}
              style={styles.largeInput}
              autoFocus
            />
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
          <Pressable
            style={[
              styles.button,
              { backgroundColor: isFormValid ? colors.primary : colors.muted },
            ]}
            onPress={handleNext}
            disabled={!isFormValid}
          >
            <Text style={[styles.buttonText, { color: isFormValid ? colors.primaryForeground : colors.mutedForeground }]}>
              Continue
            </Text>
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
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  stepText: { fontSize: 14, fontWeight: '600' },
  content: { padding: 24, paddingBottom: 40 },
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 16 },
  subtitle: { fontSize: 16, lineHeight: 24, marginBottom: 40 },
  inputWrapper: {
    alignItems: 'center',
  },
  largeInput: {
    height: 80,
  },
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
});
