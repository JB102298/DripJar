import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';

export default function CreateJarStep6() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly');

  const goalAmount = state.goalAmountCents || 0;
  const totalPeople = (state.invitees?.length || 0) + 1;
  const splitAmount = goalAmount / totalPeople;

  // Let's assume there's 6 months to target date for mockup calculation
  const months = 6; 
  let paymentAmount = splitAmount / months;
  if (frequency === 'weekly') paymentAmount = splitAmount / (months * 4);
  if (frequency === 'biweekly') paymentAmount = splitAmount / (months * 2);

  const handleNext = () => {
    updateState({ contributionPlan: { frequency, amountCents: paymentAmount } });
    router.push('/create-jar/rules');
  };

  const formatCurrency = (cents: number) => {
    return '$' + (Math.round(cents / 100)).toLocaleString('en-US');
  };

  const OptionCard = ({ type, title, subtitle }: { type: any, title: string, subtitle: string }) => {
    const isSelected = frequency === type;
    return (
      <Pressable
        style={[
          styles.optionCard,
          { backgroundColor: colors.card, borderColor: isSelected ? colors.primary : colors.border },
          isSelected && { backgroundColor: colors.secondary }
        ]}
        onPress={() => setFrequency(type)}
      >
        <View style={styles.optionContent}>
          <Text style={[styles.optionTitle, { color: isSelected ? colors.primary : colors.foreground }]}>{title}</Text>
          <Text style={[styles.optionSubtitle, { color: colors.mutedForeground }]}>{subtitle}</Text>
        </View>
        <View style={[
          styles.radio, 
          { borderColor: isSelected ? colors.primary : colors.mutedForeground },
          isSelected && { backgroundColor: colors.primary }
        ]}>
          {isSelected && <Feather name="check" size={14} color="#fff" />}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 6 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={75} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>How will you save?</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Based on your goal and target date, here's what each person needs to save.
        </Text>

        <View style={styles.optionsContainer}>
          <OptionCard type="weekly" title="Weekly" subtitle={`${formatCurrency(paymentAmount)} / week`} />
          <OptionCard type="biweekly" title="Bi-weekly" subtitle={`${formatCurrency(paymentAmount * 2)} / 2 weeks`} />
          <OptionCard type="monthly" title="Monthly" subtitle={`${formatCurrency(paymentAmount * 4)} / month`} />
        </View>

        <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="info" size={20} color={colors.primary} style={{ marginRight: 12, marginTop: 2 }} />
          <Text style={[styles.infoText, { color: colors.foreground }]}>
            You can always make extra manual contributions anytime, or skip a scheduled contribution if needed.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={handleNext}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
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
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 16 },
  subtitle: { fontSize: 16, lineHeight: 24, marginBottom: 32 },
  optionsContainer: { gap: 16, marginBottom: 32 },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    borderWidth: 2,
    borderRadius: 16,
  },
  optionContent: { flex: 1 },
  optionTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  optionSubtitle: { fontSize: 15 },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoCard: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  infoText: { flex: 1, fontSize: 14, lineHeight: 20 },
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
