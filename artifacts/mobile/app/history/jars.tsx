/**
 * Jar History — every jar the caller has ever joined.
 *
 * This is the drill-down behind the Profile "Jars" and "Contributed" stats.
 * Both the header total here and the Profile stat come from the same
 * `summary` object on `GET /me/jars`, and the per-jar rows are the figures that
 * total was summed from — so the screen proves its own headline rather than
 * asking the reader to trust it.
 *
 * Jars the caller has left are included and labelled. Dropping them would make
 * the lifetime total unexplainable: money contributed to a jar you later left
 * is still money you contributed.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useListMyJars } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { resolveCategory } from '@/lib/jar-categories';
import { formatISOForPrecision, resolvePrecision } from '@/lib/date-precision';

function formatMoney(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function JarHistoryScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { data, isLoading, isError } = useListMyJars();

  const summary = data?.summary;
  const jars = data?.jars ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton} testID="jar-history-back">
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Jar History</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {isLoading ? (
          <ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />
        ) : isError ? (
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Could not load your jar history. Pull back and try again.
          </Text>
        ) : (
          <>
            {summary ? (
              <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.summaryRow}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                    Contributed all time
                  </Text>
                  <Text testID="history-lifetime-total" style={[styles.summaryValueLarge, { color: colors.primary }]}>
                    {formatMoney(summary.lifetimeContributedPrincipalCents)}
                  </Text>
                </View>
                <View style={[styles.divider, { backgroundColor: colors.border }]} />
                <View style={styles.summaryRow}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Currently saved</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                    {formatMoney(summary.currentlySavedPrincipalCents)}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Refunded</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                    {formatMoney(summary.refundedPrincipalCents)}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Jars joined</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>{summary.jarCount}</Text>
                </View>
                {/*
                  When the ledger sum and the canonical member balance disagree
                  the split cannot be trusted, so say so instead of rendering
                  numbers that do not add up.
                */}
                {!summary.reconciles ? (
                  <Text testID="history-reconcile-warning" style={[styles.warning, { color: colors.warning }]}>
                    Some per-jar figures could not be reconciled and are hidden. The all-time total above is
                    still correct.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {jars.length === 0 ? (
              <EmptyState
                icon="archive"
                title="No jars yet"
                description="Once you join or create a jar it will appear here."
              />
            ) : (
              jars.map((jar) => {
                const category = resolveCategory(jar.category ?? null);
                const isPast = jar.membershipStatus !== 'active';
                return (
                  <Pressable
                    key={jar.jarId}
                    testID={`jar-history-row-${jar.jarId}`}
                    onPress={() => router.push(`/jar/${jar.jarId}`)}
                    style={({ pressed }) => [
                      styles.jarCard,
                      { backgroundColor: colors.card, borderColor: colors.border },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <View style={styles.jarTopRow}>
                      <View style={styles.jarIconWrap}>
                        <Feather name={category.icon} size={18} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.jarName, { color: colors.foreground }]} numberOfLines={1}>
                          {jar.name}
                        </Text>
                        <Text testID={`jar-history-meta-${jar.jarId}`} style={[styles.jarMeta, { color: colors.mutedForeground }]}>
                          {category.label} · {jar.status} ·{' '}
                          {/* The jar's own stored precision, not a fixed one. */}
                          {formatISOForPrecision(jar.targetDate, resolvePrecision(jar.targetDatePrecision))}
                        </Text>
                      </View>
                      {isPast ? (
                        <View style={[styles.chip, { backgroundColor: colors.muted }]}>
                          <Text style={[styles.chipText, { color: colors.mutedForeground }]}>
                            {jar.membershipStatus}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {jar.reconciles ? (
                      <View style={styles.jarStats}>
                        <View style={styles.jarStat}>
                          <Text style={[styles.jarStatValue, { color: colors.primary }]}>
                            {formatMoney(jar.lifetimeContributedPrincipalCents)}
                          </Text>
                          <Text style={[styles.jarStatLabel, { color: colors.mutedForeground }]}>
                            Contributed
                          </Text>
                        </View>
                        <View style={styles.jarStat}>
                          <Text style={[styles.jarStatValue, { color: colors.foreground }]}>
                            {formatMoney(jar.currentlySavedPrincipalCents)}
                          </Text>
                          <Text style={[styles.jarStatLabel, { color: colors.mutedForeground }]}>
                            Still saved
                          </Text>
                        </View>
                        <View style={styles.jarStat}>
                          <Text style={[styles.jarStatValue, { color: colors.foreground }]}>
                            {jar.contributionCount}
                          </Text>
                          <Text style={[styles.jarStatLabel, { color: colors.mutedForeground }]}>
                            {jar.contributionCount === 1 ? 'Drip' : 'Drips'}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      <Text style={[styles.warning, { color: colors.warning }]}>
                        Figures for this jar could not be reconciled and are hidden.
                      </Text>
                    )}
                  </Pressable>
                );
              })
            )}
          </>
        )}
      </ScrollView>
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
  headerTitle: { fontSize: 17, fontWeight: '700' },
  content: { padding: 16 },
  errorText: { fontSize: 15, marginTop: 32, textAlign: 'center' },
  summaryCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    marginBottom: 24,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  summaryLabel: { fontSize: 15 },
  summaryValue: { fontSize: 16, fontWeight: '600' },
  summaryValueLarge: { fontSize: 26, fontWeight: 'bold' },
  divider: { height: 1, marginVertical: 10 },
  warning: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  jarCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  jarTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  jarIconWrap: { width: 32, alignItems: 'center' },
  jarName: { fontSize: 16, fontWeight: '700' },
  jarMeta: { fontSize: 13, marginTop: 2 },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  chipText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  jarStats: { flexDirection: 'row', marginTop: 16 },
  jarStat: { flex: 1 },
  jarStatValue: { fontSize: 16, fontWeight: '700' },
  jarStatLabel: { fontSize: 12, marginTop: 2 },
});
