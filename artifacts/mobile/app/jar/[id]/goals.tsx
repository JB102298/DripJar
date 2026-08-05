/**
 * Manage Goals Screen — Phase 4D
 * Route: /jar/[id]/goals   (Expo Router: app/jar/[id]/goals.tsx)
 *
 * Organizer-facing goal management: list, create, edit, reorder, remove goals.
 * Regular members see the goal list read-only (organizer controls hidden).
 * All financial/accounting logic stays on the server — this screen is planning
 * metadata only.
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
  TextInput,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { ProgressBar } from '@/components/ProgressBar';
import { CurrencyInput } from '@/components/CurrencyInput';
import { useJarGoals, type GoalAllocation } from '@/hooks/useJarGoals';
import { useGoalMutations } from '@/hooks/useGoalMutations';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fundingIcon(state: GoalAllocation['fundingState']): React.ComponentProps<typeof Feather>['name'] {
  if (state === 'funded') return 'check-circle';
  if (state === 'partially_funded') return 'circle';
  return 'circle';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SummaryColProps {
  label: string;
  value: number;
  testID?: string;
  accent?: boolean;
}
function SummaryCol({ label, value, testID, accent }: SummaryColProps) {
  const colors = useColors();
  return (
    <View style={summaryColStyles.col}>
      <Text testID={testID} style={[summaryColStyles.value, { color: accent ? colors.primary : colors.foreground }]}>
        {fmt(value)}
      </Text>
      <Text style={[summaryColStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}
const summaryColStyles = StyleSheet.create({
  col: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  value: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 11, marginTop: 2 },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ManageGoalsScreen() {
  const { id: jarId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data, isLoading, refetch } = useJarGoals(jarId, { enabled: !!jarId });
  const mutations = useGoalMutations(jarId ?? '');

  const isOrganizer = data?.isOrganizer ?? false;
  const goals = data?.goals ?? [];
  const goalAmountCents = data?.goalAmountCents ?? 0;
  const activeGoalTargetSum = goals.reduce((s, g) => s + g.targetPrincipalCents, 0);
  const unallocatedTargetCents = data?.unallocatedTargetCents ?? data?.unallocatedCents ?? 0;
  const savedTowardUnallocatedCents = data?.savedTowardUnallocatedCents ?? 0;
  const overTargetCents = data?.overTargetCents ?? 0;

  // ── Modal / form state ────────────────────────────────────────────────────
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingGoal, setEditingGoal] = useState<GoalAllocation | null>(null);
  const [formName, setFormName] = useState('');
  const [formTargetCents, setFormTargetCents] = useState(0);
  const [formDescription, setFormDescription] = useState('');
  const [formError, setFormError] = useState('');

  // ── Modal helpers ─────────────────────────────────────────────────────────
  const openCreate = useCallback(() => {
    setEditingGoal(null);
    setFormName('');
    setFormTargetCents(0);
    setFormDescription('');
    setFormError('');
    mutations.clearError();
    setModalMode('create');
  }, [mutations]);

  const openEdit = useCallback((goal: GoalAllocation) => {
    setEditingGoal(goal);
    setFormName(goal.name);
    setFormTargetCents(goal.targetPrincipalCents);
    setFormDescription(goal.description ?? '');
    setFormError('');
    mutations.clearError();
    setModalMode('edit');
  }, [mutations]);

  const closeModal = useCallback(() => {
    setModalMode(null);
    setEditingGoal(null);
    mutations.clearError();
  }, [mutations]);

  // ── Form submit ───────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError('Goal name is required');
      return;
    }
    if (formTargetCents < 1) {
      setFormError('Target amount must be greater than zero');
      return;
    }
    setFormError('');

    try {
      if (modalMode === 'create') {
        await mutations.createGoal({
          name: trimmedName,
          targetPrincipalCents: formTargetCents,
          description: formDescription.trim() || null,
        });
      } else if (editingGoal) {
        await mutations.updateGoal(editingGoal.id, {
          name: trimmedName,
          targetPrincipalCents: formTargetCents,
          description: formDescription.trim() || null,
        });
      }
      closeModal();
      await refetch();
    } catch (e: any) {
      // Prefer the mutation hook's error; fall back to raw message
      if (!mutations.error) {
        setFormError(e?.message ?? 'Something went wrong. Please try again.');
      }
    }
  }, [formName, formTargetCents, formDescription, modalMode, editingGoal, mutations, closeModal, refetch]);

  // ── Remove ────────────────────────────────────────────────────────────────
  const doRemove = useCallback(async (goalId: string) => {
    try {
      await mutations.archiveGoal(goalId);
      await refetch();
    } catch (e: any) {
      const msg = e?.message ?? 'Please try again.';
      if (Platform.OS === 'web') {
        window.alert(`Could not remove goal: ${msg}`);
      } else {
        Alert.alert('Could not remove goal', msg);
      }
    }
  }, [mutations, refetch]);

  const handleRemove = useCallback((goal: GoalAllocation) => {
    const title = 'Remove Goal';
    const message =
      `Remove "${goal.name}"? This goal will be removed from the active plan. ` +
      `If the jar has already launched, it will be kept in the jar's history.`;
    if (Platform.OS === 'web') {
      if (window.confirm(`${title}\n\n${message}`)) doRemove(goal.id);
    } else {
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => doRemove(goal.id) },
      ]);
    }
  }, [doRemove]);

  // ── Reorder ───────────────────────────────────────────────────────────────
  const handleMove = useCallback(async (idx: number, direction: 'up' | 'down') => {
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= goals.length) return;
    const newOrder = [...goals];
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx]!, newOrder[idx]!];
    const newIds = newOrder.map(g => g.id);
    try {
      await mutations.reorderGoals(newIds);
      await refetch();
    } catch {
      await refetch(); // rollback to server canonical order
    }
  }, [goals, mutations, refetch]);

  // ── Budget context for form ────────────────────────────────────────────────
  const otherGoalsCents = goals
    .filter(g => g.id !== editingGoal?.id)
    .reduce((s, g) => s + g.targetPrincipalCents, 0);
  const projectedUnallocated = Math.max(0, goalAmountCents - otherGoalsCents - formTargetCents);
  const budgetExceeded = goalAmountCents > 0 && otherGoalsCents + formTargetCents > goalAmountCents;

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 12, backgroundColor: colors.card, borderBottomColor: colors.border },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn} testID="back-button">
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Manage Goals</Text>
        <View style={styles.backBtn} /> {/* spacer */}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 80 }]}
      >
        {/* ── Summary card ── */}
        <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SummaryCol label="Jar Target" value={goalAmountCents} testID="summary-jar-target" />
          <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
          <SummaryCol label="Allocated" value={activeGoalTargetSum} testID="summary-allocated" />
          <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
          <SummaryCol
            label="Unallocated"
            value={unallocatedTargetCents}
            testID="summary-unallocated"
            accent={unallocatedTargetCents > 0}
          />
        </View>

        {overTargetCents > 0 && (
          <View style={[styles.overTargetBanner, { backgroundColor: colors.warning + '20', borderColor: colors.warning }]}>
            <Feather name="alert-triangle" size={14} color={colors.warning} />
            <Text style={[styles.overTargetText, { color: colors.warning }]}>
              {'  '}
              <Text testID="summary-over-target">{fmt(overTargetCents)}</Text>
              {' saved above jar target'}
            </Text>
          </View>
        )}

        {savedTowardUnallocatedCents > 0 && (
          <View style={[styles.infoRow, { borderColor: colors.border }]}>
            <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Saved toward unallocated</Text>
            <Text testID="summary-saved-unallocated" style={[styles.infoValue, { color: colors.foreground }]}>
              {fmt(savedTowardUnallocatedCents)}
            </Text>
          </View>
        )}

        {/* ── Goals list ── */}
        {goals.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="target" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No goals yet</Text>
            {isOrganizer && (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                Tap "Add Goal" to create your first named goal.
              </Text>
            )}
          </View>
        ) : (
          <View style={[styles.goalsList, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {goals.map((goal, idx) => (
              <View
                key={goal.id}
                testID={`goal-item-${goal.id}`}
                style={[
                  styles.goalRow,
                  idx > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
                ]}
              >
                {/* Title row */}
                <View style={styles.goalTitleRow}>
                  <Feather
                    name={fundingIcon(goal.fundingState)}
                    size={16}
                    color={goal.fundingState === 'funded' ? colors.success : colors.mutedForeground}
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[styles.goalName, { color: colors.foreground }]} numberOfLines={1}>
                    {goal.name}
                  </Text>
                  <Text style={[styles.goalTarget, { color: colors.mutedForeground }]}>
                    {fmt(goal.targetPrincipalCents)}
                  </Text>
                </View>

                {/* Progress */}
                <View style={styles.goalProgress}>
                  <ProgressBar
                    progress={goal.savedPercent}
                    color={colors.primary}
                    backgroundColor={colors.muted}
                    height={4}
                  />
                  <Text style={[styles.goalPercent, { color: colors.mutedForeground }]}>
                    {fmt(goal.savedAllocatedCents)} saved
                    {goal.committedAllocatedCents > 0 && ` · ${fmt(goal.committedAllocatedCents)} locked`}
                  </Text>
                </View>

                {/* Description */}
                {goal.description ? (
                  <Text style={[styles.goalDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                    {goal.description}
                  </Text>
                ) : null}

                {/* Organizer controls */}
                {isOrganizer && (
                  <View style={styles.goalControls}>
                    <Pressable
                      testID={`goal-move-up-${goal.id}`}
                      onPress={() => handleMove(idx, 'up')}
                      disabled={idx === 0 || mutations.submitting}
                      style={[styles.controlBtn, { opacity: idx === 0 ? 0.3 : 1 }]}
                    >
                      <Feather name="chevron-up" size={18} color={colors.foreground} />
                    </Pressable>

                    <Pressable
                      testID={`goal-move-down-${goal.id}`}
                      onPress={() => handleMove(idx, 'down')}
                      disabled={idx === goals.length - 1 || mutations.submitting}
                      style={[styles.controlBtn, { opacity: idx === goals.length - 1 ? 0.3 : 1 }]}
                    >
                      <Feather name="chevron-down" size={18} color={colors.foreground} />
                    </Pressable>

                    <Pressable
                      testID={`goal-edit-${goal.id}`}
                      onPress={() => openEdit(goal)}
                      disabled={mutations.submitting}
                      style={styles.controlBtn}
                    >
                      <Feather name="edit-2" size={16} color={colors.primary} />
                    </Pressable>

                    <Pressable
                      testID={`goal-remove-${goal.id}`}
                      onPress={() => handleRemove(goal)}
                      disabled={mutations.submitting}
                      style={styles.controlBtn}
                    >
                      <Feather name="trash-2" size={16} color={colors.destructive} />
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ── Add Goal button ── */}
        {isOrganizer && (
          <Pressable
            testID="add-goal-button"
            onPress={openCreate}
            disabled={mutations.submitting}
            style={[styles.addBtn, { backgroundColor: colors.primary }]}
          >
            <Feather name="plus" size={18} color={colors.primaryForeground} />
            <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>Add Goal</Text>
          </Pressable>
        )}
      </ScrollView>

      {/* ── Create / Edit form (inline conditional — avoids react-native-web Modal DOM retention) ── */}
      {modalMode !== null && (
        <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
          <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
            {/* Header */}
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                {modalMode === 'create' ? 'Add Goal' : 'Edit Goal'}
              </Text>
              <Pressable testID="goal-cancel-button" onPress={closeModal}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {/* Name */}
              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Goal Name *</Text>
              <TextInput
                testID="goal-name-input"
                style={[
                  styles.textInput,
                  { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border },
                ]}
                value={formName}
                onChangeText={setFormName}
                placeholder="e.g. Wedding venue"
                placeholderTextColor={colors.mutedForeground}
                maxLength={100}
              />

              {/* Target amount */}
              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Target Amount *</Text>
              <CurrencyInput
                testID="goal-target-input"
                value={formTargetCents}
                onChangeCents={setFormTargetCents}
                label=""
              />

              {/* Description */}
              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Description (optional)</Text>
              <TextInput
                testID="goal-description-input"
                style={[
                  styles.textInput,
                  styles.textAreaInput,
                  { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border },
                ]}
                value={formDescription}
                onChangeText={setFormDescription}
                placeholder="What is this goal for?"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                maxLength={500}
              />

              {/* Budget context */}
              {goalAmountCents > 0 && (
                <View style={[styles.budgetBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <Text style={[styles.budgetTitle, { color: colors.mutedForeground }]}>Planning Summary</Text>
                  <BudgetRow label="Jar target" value={goalAmountCents} colors={colors} />
                  {otherGoalsCents > 0 && (
                    <BudgetRow label="Other goals" value={otherGoalsCents} colors={colors} />
                  )}
                  {formTargetCents > 0 && (
                    <BudgetRow
                      label={modalMode === 'create' ? 'This goal' : 'Updated target'}
                      value={formTargetCents}
                      colors={colors}
                      accent
                    />
                  )}
                  <View style={[styles.budgetDivider, { backgroundColor: colors.border }]} />
                  <BudgetRow
                    label="Remaining unallocated"
                    value={projectedUnallocated}
                    colors={colors}
                    warn={budgetExceeded}
                  />
                </View>
              )}

              {/* Validation + server errors */}
              {(formError || mutations.error) && (
                <View style={[styles.errorBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive }]}>
                  <Feather name="alert-circle" size={14} color={colors.destructive} />
                  <Text testID="goal-form-error" style={[styles.errorText, { color: colors.destructive }]}>
                    {'  '}{formError || mutations.error}
                  </Text>
                </View>
              )}

              {budgetExceeded && !formError && !mutations.error && (
                <View style={[styles.errorBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive }]}>
                  <Text testID="goal-budget-warning" style={[styles.errorText, { color: colors.destructive }]}>
                    Your named goals can't total more than the Jar target.
                  </Text>
                </View>
              )}

              {/* Actions */}
              <View style={styles.modalActions}>
                <Pressable
                  onPress={closeModal}
                  style={[styles.modalBtn, styles.cancelBtn, { backgroundColor: colors.secondary }]}
                >
                  <Text style={[styles.modalBtnText, { color: colors.secondaryForeground }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  testID="goal-save-button"
                  onPress={handleSave}
                  disabled={mutations.submitting}
                  style={[styles.modalBtn, { backgroundColor: colors.primary, opacity: mutations.submitting ? 0.6 : 1 }]}
                >
                  {mutations.submitting ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>
                      {modalMode === 'create' ? 'Add Goal' : 'Save Changes'}
                    </Text>
                  )}
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Budget row helper ─────────────────────────────────────────────────────────

function BudgetRow({
  label,
  value,
  colors,
  accent = false,
  warn = false,
}: {
  label: string;
  value: number;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
  accent?: boolean;
  warn?: boolean;
}) {
  const color = warn ? colors.destructive : accent ? colors.primary : colors.foreground;
  return (
    <View style={styles.budgetRow}>
      <Text style={[styles.budgetLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.budgetValue, { color }]}>{fmt(value)}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  backBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12 },

  // Summary card
  summaryCard: {
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  summaryDivider: { width: 1 },

  // Over-target / info banners
  overTargetBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  overTargetText: { fontSize: 13 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 13, fontWeight: '600' },

  // Empty state
  emptyCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyHint: { fontSize: 13, textAlign: 'center' },

  // Goals list
  goalsList: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  goalRow: { padding: 14, gap: 8 },
  goalTitleRow: { flexDirection: 'row', alignItems: 'center' },
  goalName: { flex: 1, fontSize: 15, fontWeight: '600' },
  goalTarget: { fontSize: 14, fontWeight: '500' },
  goalProgress: { gap: 4 },
  goalPercent: { fontSize: 12 },
  goalDesc: { fontSize: 13 },
  goalControls: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 4,
    paddingTop: 4,
  },
  controlBtn: { padding: 6 },

  // Add button
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 12,
  },
  addBtnText: { fontSize: 16, fontWeight: '600' },

  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  modalScroll: { padding: 16 },

  // Form fields
  fieldLabel: { fontSize: 14, fontWeight: '500', marginBottom: 6, marginTop: 14 },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  textAreaInput: { minHeight: 80, textAlignVertical: 'top' },

  // Budget box
  budgetBox: {
    marginTop: 16,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  budgetTitle: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  budgetRow: { flexDirection: 'row', justifyContent: 'space-between' },
  budgetLabel: { fontSize: 13 },
  budgetValue: { fontSize: 13, fontWeight: '600' },
  budgetDivider: { height: 1, marginVertical: 4 },

  // Error
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 12,
  },
  errorText: { fontSize: 13, flex: 1 },

  // Modal actions
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
    marginBottom: 8,
  },
  modalBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {},
  modalBtnText: { fontSize: 15, fontWeight: '600' },
});
