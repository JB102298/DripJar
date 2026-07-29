/**
 * ScheduleSetupSheet
 *
 * A bottom-sheet-style modal that lets a jar member create or edit their
 * contribution schedule (frequency + amount).
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { CurrencyInput } from '@/components/CurrencyInput';
import {
  useGetContributionSchedule,
  useCreateContributionSchedule,
  useUpdateContributionSchedule,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ContributionSchedule } from '@workspace/api-client-react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Frequency = 'weekly' | 'biweekly' | 'monthly';

const FREQUENCY_OPTIONS: { value: Frequency; label: string; description: string }[] = [
  { value: 'weekly', label: 'Weekly', description: 'Every week on the same day' },
  { value: 'biweekly', label: 'Every 2 weeks', description: 'Every other week' },
  { value: 'monthly', label: 'Monthly', description: 'Once a month' },
];

interface Props {
  visible: boolean;
  jarId: string;
  onClose: () => void;
}

export function ScheduleSetupSheet({ visible, jarId, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data: existingSchedule, isLoading: loadingSchedule } = useGetContributionSchedule(jarId, {
    query: { enabled: visible && !!jarId },
  });

  const { mutateAsync: createSchedule, isPending: creating } = useCreateContributionSchedule();
  const { mutateAsync: updateSchedule, isPending: updating } = useUpdateContributionSchedule();

  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [amountCents, setAmountCents] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Pre-fill from existing schedule
  useEffect(() => {
    if (existingSchedule) {
      const freq = existingSchedule.frequency as Frequency;
      if (['weekly', 'biweekly', 'monthly'].includes(freq)) setFrequency(freq);
      setAmountCents(existingSchedule.amountCents);
      setIsPaused(existingSchedule.isPaused);
    }
  }, [existingSchedule]);

  const isSaving = creating || updating;

  const handleSave = async () => {
    if (amountCents <= 0) {
      setError('Please enter an amount greater than $0.');
      return;
    }
    setError('');
    try {
      if (existingSchedule) {
        // Update existing
        await updateSchedule({
          jarId,
          data: { frequency, amountCents, isPaused },
        });
      } else {
        // Create new
        const today = new Date();
        const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        await createSchedule({
          jarId,
          data: { frequency, amountCents, startDate, endCondition: 'targetDate' },
        });
      }
      // Invalidate dashboard so next-contribution chip updates
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/schedule`] });
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 1400);
    } catch (e: any) {
      setError(e?.message || 'Failed to save schedule. Please try again.');
    }
  };

  const handleTogglePause = async () => {
    if (!existingSchedule) return;
    try {
      await updateSchedule({ jarId, data: { isPaused: !isPaused } });
      setIsPaused((p) => !p);
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      queryClient.invalidateQueries({ queryKey: [`/api/jars/${jarId}/schedule`] });
    } catch {
      // ignore
    }
  };

  const formatAmount = (cents: number) =>
    '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.background }]}
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 16, borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={24} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            {existingSchedule ? 'Edit Schedule' : 'Set Up Schedule'}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          {loadingSchedule ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
          ) : success ? (
            <View style={styles.successContainer}>
              <Feather name="check-circle" size={64} color={colors.primary} />
              <Text style={[styles.successText, { color: colors.foreground }]}>Schedule saved!</Text>
            </View>
          ) : (
            <>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                How often would you like to contribute?
              </Text>

              <View style={styles.optionsRow}>
                {FREQUENCY_OPTIONS.map((opt) => {
                  const isSelected = frequency === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => setFrequency(opt.value)}
                      style={[
                        styles.freqOption,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.card,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.freqLabel, { color: isSelected ? colors.primaryForeground : colors.foreground }]}>
                        {opt.label}
                      </Text>
                      <Text style={[styles.freqDesc, { color: isSelected ? 'rgba(255,255,255,0.75)' : colors.mutedForeground }]}>
                        {opt.description}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 28 }]}>
                Amount per contribution
              </Text>

              <CurrencyInput
                value={amountCents}
                onChangeCents={setAmountCents}
                autoFocus={!existingSchedule}
              />

              {/* Summary chip */}
              {amountCents > 0 && (
                <View style={[styles.summaryChip, { backgroundColor: colors.secondary }]}>
                  <Feather name="calendar" size={14} color={colors.primary} />
                  <Text style={[styles.summaryText, { color: colors.secondaryForeground }]}>
                    {formatAmount(amountCents)}{' '}
                    {frequency === 'weekly'
                      ? 'every week'
                      : frequency === 'biweekly'
                      ? 'every two weeks'
                      : 'every month'}
                  </Text>
                </View>
              )}

              {error ? (
                <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
              ) : null}

              <Pressable
                style={[
                  styles.saveButton,
                  { backgroundColor: colors.primary, opacity: isSaving ? 0.7 : 1 },
                ]}
                onPress={handleSave}
                disabled={isSaving}
              >
                {isSaving ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.saveButtonText, { color: colors.primaryForeground }]}>
                    {existingSchedule ? 'Update Schedule' : 'Start Schedule'}
                  </Text>
                )}
              </Pressable>

              {/* Pause / Resume toggle for existing schedule */}
              {existingSchedule && (
                <Pressable
                  style={[styles.secondaryButton, { borderColor: colors.border }]}
                  onPress={handleTogglePause}
                >
                  <Feather name={isPaused ? 'play' : 'pause'} size={16} color={colors.foreground} />
                  <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>
                    {isPaused ? 'Resume Schedule' : 'Pause Schedule'}
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { padding: 8, marginLeft: -8 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  content: { padding: 20 },
  sectionLabel: { fontSize: 14, fontWeight: '500', marginBottom: 12 },
  optionsRow: { gap: 12 },
  freqOption: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  freqLabel: { fontSize: 16, fontWeight: '700', marginBottom: 2 },
  freqDesc: { fontSize: 13 },
  summaryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    marginTop: 16,
  },
  summaryText: { fontSize: 14, fontWeight: '600' },
  errorText: { marginTop: 12, fontSize: 13 },
  saveButton: {
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  saveButtonText: { fontSize: 16, fontWeight: '700' },
  secondaryButton: {
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600' },
  successContainer: { alignItems: 'center', paddingTop: 60, gap: 16 },
  successText: { fontSize: 20, fontWeight: '700' },
});
