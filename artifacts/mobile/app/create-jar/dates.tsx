import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { DateInput } from '@/components/DateInput';

export default function CreateJarStep2() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  // Parse stored YYYY-MM-DD at noon local time to avoid UTC-shift off-by-one
  const parseLocal = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
  // Store as YYYY-MM-DD using local calendar date (not UTC)
  const toLocalISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const startDate = state.startDate ? parseLocal(state.startDate) : undefined;
  const endDate = state.endDate ? parseLocal(state.endDate) : undefined;
  const targetDate = state.targetDate ? parseLocal(state.targetDate) : undefined;

  const isFormValid = !!targetDate && (!startDate || targetDate <= startDate);

  const handleNext = () => {
    if (isFormValid) {
      router.push('/create-jar/goal');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 2 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={25} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>When is the trip?</Text>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Trip Start Date (Optional)</Text>
          <DateInput
            value={startDate}
            onChange={(d) => updateState({ startDate: toLocalISO(d) })}
            placeholder="Select trip start date"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Trip End Date (Optional)</Text>
          <DateInput
            value={endDate}
            onChange={(d) => updateState({ endDate: toLocalISO(d) })}
            placeholder="Select trip end date"
          />
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Savings Target Date</Text>
          <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>
            When do you want to have all the money saved by? We recommend 30-60 days before the trip.
          </Text>
          <DateInput
            value={targetDate}
            onChange={(d) => updateState({ targetDate: toLocalISO(d) })}
            placeholder="Select target date"
          />
          {targetDate && startDate && targetDate > startDate && (
            <Text style={[styles.errorText, { color: colors.destructive }]}>
              Target date must be before the trip start date.
            </Text>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Commitment Date (Optional)</Text>
          <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>
            The date when contributions become committed to the jar's purpose. After this date, members
            enter the Commitment phase and schedules can no longer be changed. Must be before the
            Savings Target Date.
          </Text>
          <DateInput
            value={state.cutoffDate ? parseLocal(state.cutoffDate) : undefined}
            onChange={(d) => updateState({ cutoffDate: toLocalISO(d) })}
            placeholder="Select commitment date (optional)"
          />
          {state.cutoffDate && targetDate && parseLocal(state.cutoffDate) >= targetDate && (
            <Text style={[styles.errorText, { color: colors.destructive }]}>
              Commitment date must be before the savings target date.
            </Text>
          )}
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 32 },
  inputGroup: { marginBottom: 24 },
  label: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  subLabel: { fontSize: 14, marginBottom: 12, lineHeight: 20 },
  divider: { height: 1, marginVertical: 16 },
  errorText: { marginTop: 8, fontSize: 14 },
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
