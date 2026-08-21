import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Modal, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { CurrencyInput } from '@/components/CurrencyInput';
import { resolveCategory } from '@/lib/jar-categories';

export default function CreateJarStep4() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  // "Flights, Lodging, Activities" is a useful prompt for a cruise and a
  // baffling one for an emergency fund. Both the chips and the help line come
  // from the category record.
  const category = resolveCategory(state.category);
  const suggestions = category.milestoneSuggestions;

  const [milestones, setMilestones] = useState<{name: string, targetAmountCents: number}[]>(state.milestones || []);
  
  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAmount, setNewAmount] = useState(0);

  const goalAmount = state.goalAmountCents || 0;
  const totalAllocated = milestones.reduce((sum, m) => sum + m.targetAmountCents, 0);

  const handleAddMilestone = () => {
    if (newName && newAmount > 0) {
      setMilestones([...milestones, { name: newName, targetAmountCents: newAmount }]);
      setNewName('');
      setNewAmount(0);
      setModalVisible(false);
    }
  };

  const removeMilestone = (index: number) => {
    const next = [...milestones];
    next.splice(index, 1);
    setMilestones(next);
  };

  const handleNext = () => {
    updateState({ milestones });
    router.push('/create-jar/members');
  };

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 4 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={50} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Break it down</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {category.milestoneHelp}
        </Text>

        <View style={[styles.summaryCard, { backgroundColor: colors.secondary }]}>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.secondaryForeground }]}>Total Goal</Text>
            <Text style={[styles.summaryValue, { color: colors.secondaryForeground }]}>{formatCurrency(goalAmount)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.secondaryForeground }]}>Allocated</Text>
            <Text style={[styles.summaryValue, { color: colors.secondaryForeground }]}>{formatCurrency(totalAllocated)}</Text>
          </View>
          {totalAllocated > goalAmount && (
            <Text style={[styles.errorText, { color: colors.destructive, marginTop: 8 }]}>
              You've allocated more than your total goal.
            </Text>
          )}
        </View>

        <View style={styles.suggestionsContainer}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quick Add</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestionsScroll}>
            {suggestions.map(s => (
              <Pressable
                key={s}
                testID={`milestone-suggestion-${s}`}
                style={[styles.suggestionChip, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => {
                  setNewName(s);
                  setNewAmount(0);
                  setModalVisible(true);
                }}
              >
                <Feather name="plus" size={16} color={colors.primary} />
                <Text style={[styles.suggestionText, { color: colors.foreground }]}>{s}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.listContainer}>
          {milestones.map((m, i) => (
            <View key={i} style={[styles.milestoneRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.milestoneInfo}>
                <Text style={[styles.milestoneName, { color: colors.foreground }]}>{m.name}</Text>
                <Text style={[styles.milestoneAmount, { color: colors.mutedForeground }]}>{formatCurrency(m.targetAmountCents)}</Text>
              </View>
              <Pressable onPress={() => removeMilestone(i)} style={styles.removeButton}>
                <Feather name="trash-2" size={20} color={colors.destructive} />
              </Pressable>
            </View>
          ))}
          
          <Pressable 
            style={[styles.addCustomButton, { borderColor: colors.border }]}
            onPress={() => {
              setNewName('');
              setNewAmount(0);
              setModalVisible(true);
            }}
          >
            <Feather name="plus" size={20} color={colors.primary} />
            <Text style={[styles.addCustomText, { color: colors.primary }]}>Add Custom Milestone</Text>
          </Pressable>
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

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalContent}>
            <View style={[styles.modalInner, { backgroundColor: colors.background, paddingBottom: insets.bottom + 24 }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Add Milestone</Text>
                <Pressable onPress={() => setModalVisible(false)}>
                  <Feather name="x" size={24} color={colors.foreground} />
                </Pressable>
              </View>
              
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: colors.foreground }]}>Name</Text>
                <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <TextInput
                    style={[styles.input, { color: colors.foreground }]}
                    value={newName}
                    onChangeText={setNewName}
                    placeholder={`e.g., ${suggestions[0] ?? 'Milestone'}`}
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: colors.foreground }]}>Target Amount</Text>
                <CurrencyInput value={newAmount} onChangeCents={setNewAmount} />
              </View>

              <Pressable
                style={[
                  styles.button,
                  { backgroundColor: newName && newAmount > 0 ? colors.primary : colors.muted, marginTop: 16 },
                ]}
                onPress={handleAddMilestone}
                disabled={!newName || newAmount <= 0}
              >
                <Text style={[styles.buttonText, { color: newName && newAmount > 0 ? colors.primaryForeground : colors.mutedForeground }]}>
                  Add Milestone
                </Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
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
  subtitle: { fontSize: 16, lineHeight: 24, marginBottom: 24 },
  summaryCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 32,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryLabel: { fontSize: 16, fontWeight: '500' },
  summaryValue: { fontSize: 16, fontWeight: 'bold' },
  errorText: { fontSize: 14, fontWeight: '600' },
  suggestionsContainer: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  suggestionsScroll: { gap: 12, paddingRight: 24 },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  suggestionText: { fontSize: 14, fontWeight: '500' },
  listContainer: { gap: 12 },
  milestoneRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  milestoneInfo: { flex: 1 },
  milestoneName: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  milestoneAmount: { fontSize: 14 },
  removeButton: { padding: 8 },
  addCustomButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  addCustomText: { fontSize: 16, fontWeight: '600' },
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
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    width: '100%',
  },
  modalInner: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: { fontSize: 20, fontWeight: 'bold' },
  inputGroup: { marginBottom: 20 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  inputContainer: {
    borderWidth: 1,
    borderRadius: 12,
    height: 56,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  input: { flex: 1, fontSize: 16 },
});
