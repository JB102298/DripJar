import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { MilestoneSummaryResponse } from '@/hooks/useMilestoneSummary';

interface MilestoneAllocationSummaryProps {
  summary: MilestoneSummaryResponse;
}

/**
 * Exact cents, unlike the whole-dollar formatter used elsewhere on this screen.
 * Rounding would defeat the point: $5,778.60 + $1,495.60 = $7,274.20 reads
 * correctly, but rounded to dollars it becomes $5,779 + $1,496 = $7,274, and
 * the identity this card exists to demonstrate visibly fails to add up.
 */
function formatCurrency(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Reconciliation header for the Milestones tab — Owner QA item 3.
 *
 * The reported problem was not a wrong number, it was an unexplained one:
 * milestones summed to $5,778 while the jar held $7,274, and no surface named
 * the $1,496 difference. A member could only read that as missing money.
 *
 * So this component's job is arithmetic the reader can check by eye:
 *
 *     allocated + not yet allocated = saved principal
 *
 * Both parts are always shown, including when unallocated is $0 — the identity
 * is the point, and a row that vanishes when it happens to be zero teaches the
 * reader nothing about what the other rows mean.
 *
 * When `reconciles` is false the split is wrong rather than coarse, and this
 * component renders the safe state instead: the canonical saved total, an
 * explanation, and no per-milestone arithmetic at all. The caller must
 * correspondingly suppress the amounts on the milestone cards themselves —
 * see `renderMilestones` in app/jar/[id].tsx. Note the API already zeroes each
 * milestone's `allocatedAmountCents` in this case, so showing them would read
 * as "nothing is funded", which is its own wrong answer.
 */
export function MilestoneAllocationSummary({ summary }: MilestoneAllocationSummaryProps) {
  const colors = useColors();
  const { savedPrincipalCents, totalAllocatedCents, unallocatedCents, reconciles } = summary;

  if (!reconciles) {
    return (
      <View
        testID="milestone-summary-unreconciled"
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.warning }]}
      >
        <View style={styles.warningHeader}>
          <Feather name="alert-triangle" size={16} color={colors.warning} />
          <Text style={[styles.warningTitle, { color: colors.foreground }]}>
            Milestone breakdown unavailable
          </Text>
        </View>

        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Saved in this jar</Text>
          <Text testID="milestone-summary-saved" style={[styles.totalValue, { color: colors.foreground }]}>
            {formatCurrency(savedPrincipalCents)}
          </Text>
        </View>

        <Text style={[styles.explainer, { color: colors.mutedForeground }]}>
          We can&apos;t reliably split this jar&apos;s savings across its milestones right now, so
          we&apos;re not showing per-milestone amounts rather than showing figures that don&apos;t add
          up. Your total saved above is correct and your money is unaffected.
        </Text>
      </View>
    );
  }

  // Bar widths, not percentages of the jar goal: this bar shows how saved money
  // is split, not how close the jar is to its target.
  const allocatedPercent = savedPrincipalCents > 0
    ? (totalAllocatedCents / savedPrincipalCents) * 100
    : 0;

  return (
    <View
      testID="milestone-summary-reconciled"
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.totalRow}>
        <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Saved in this jar</Text>
        <Text testID="milestone-summary-saved" style={[styles.totalValue, { color: colors.foreground }]}>
          {formatCurrency(savedPrincipalCents)}
        </Text>
      </View>

      <View style={[styles.splitBar, { backgroundColor: colors.muted }]}>
        <View
          style={[
            styles.splitBarFill,
            { width: `${Math.min(100, Math.max(0, allocatedPercent))}%`, backgroundColor: colors.primary },
          ]}
        />
      </View>

      <View style={styles.breakdownRow}>
        <View style={styles.legendLabel}>
          <View style={[styles.swatch, { backgroundColor: colors.primary }]} />
          <Text style={[styles.breakdownLabel, { color: colors.foreground }]}>
            Allocated to milestones
          </Text>
        </View>
        <Text testID="milestone-summary-allocated" style={[styles.breakdownValue, { color: colors.foreground }]}>
          {formatCurrency(totalAllocatedCents)}
        </Text>
      </View>

      <View style={styles.breakdownRow}>
        <View style={styles.legendLabel}>
          <View style={[styles.swatch, { backgroundColor: colors.muted, borderColor: colors.border, borderWidth: 1 }]} />
          <Text style={[styles.breakdownLabel, { color: colors.foreground }]}>Not yet allocated</Text>
        </View>
        <Text testID="milestone-summary-unallocated" style={[styles.breakdownValue, { color: colors.foreground }]}>
          {formatCurrency(unallocatedCents)}
        </Text>
      </View>

      <View style={[styles.reconcileRow, { borderTopColor: colors.border }]}>
        <Text style={[styles.reconcileLabel, { color: colors.mutedForeground }]}>Total</Text>
        <Text testID="milestone-summary-reconciled-total" style={[styles.reconcileValue, { color: colors.foreground }]}>
          {formatCurrency(totalAllocatedCents + unallocatedCents)}
        </Text>
      </View>

      <Text style={[styles.explainer, { color: colors.mutedForeground }]}>
        {savedPrincipalCents === 0
          // "Every dollar is tagged to a milestone" is technically true of an
          // empty jar and reads as nonsense. Say the plain thing instead.
          ? 'Nothing has been saved in this jar yet. Milestone funding appears here once contributions settle.'
          : unallocatedCents > 0
            ? "Not yet allocated is money you've saved that isn't tagged to a specific milestone. It's still in the jar and still yours."
            : 'Every dollar saved in this jar is tagged to a milestone.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  warningTitle: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  splitBar: {
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 14,
  },
  splitBarFill: {
    height: '100%',
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  legendLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  breakdownLabel: {
    fontSize: 14,
  },
  breakdownValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  reconcileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingTop: 10,
    marginTop: 6,
  },
  reconcileLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  reconcileValue: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  explainer: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
});
