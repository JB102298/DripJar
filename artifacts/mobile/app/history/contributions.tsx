/**
 * Contribution History — every drip the caller has made, newest first.
 *
 * ─── WHY THIS PAGINATES ──────────────────────────────────────────────────────
 *
 * The first version of this screen fetched a single capped list. A weekly
 * AutoDrip produces ~52 rows a year per member and this product explicitly
 * supports eighteen-year goals, so a cap is not a simplification — it is a
 * point at which the app quietly stops showing a member their own money.
 *
 * ─── WHY THE TOTAL DOES NOT COME FROM THE ROWS ───────────────────────────────
 *
 * `summary` is computed server-side over the caller's complete ledger history,
 * never over the loaded page. Summing the visible rows instead would make the
 * headline figure grow as the reader scrolls, which is worse than either
 * extreme: it would look like a number being discovered rather than reported.
 *
 * The consequence is that the rows only add up to the total once every page is
 * loaded, so the screen says which of the two it is currently showing rather
 * than leaving the reader to notice the gap.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { listMyContributions, type MyContributionsResponse } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';

function formatMoney(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Human label for the posting type. Test-mode money never reaches the ledger. */
function sourceLabel(transactionType: string): string {
  return transactionType === 'autodrip_contribution' ? 'AutoDrip' : 'Drip';
}

export const CONTRIBUTION_HISTORY_QUERY_KEY = ['/api/me/contributions', 'infinite'] as const;

export default function ContributionHistoryScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<MyContributionsResponse>({
    queryKey: CONTRIBUTION_HISTORY_QUERY_KEY,
    // The cursor is opaque and is handed back verbatim — the client never
    // constructs one, which is what lets the server change the ordering key
    // without breaking loaded pages.
    queryFn: ({ pageParam }) =>
      listMyContributions(pageParam ? { cursor: pageParam as string } : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.pageInfo.nextCursor ?? undefined,
  });

  const pages = data?.pages ?? [];
  // Later pages carry a freshly computed summary; use the newest one so a
  // contribution made while reading is reflected in the total.
  const summary = pages.length > 0 ? pages[pages.length - 1]!.summary : undefined;
  const contributions = pages.flatMap((page) => page.contributions);
  const loadedTotal = contributions.reduce((sum, c) => sum + c.principalCents, 0);
  const showingAll = !hasNextPage && summary !== undefined;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton} testID="contribution-history-back">
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Contribution History</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {isLoading ? (
          <ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />
        ) : isError ? (
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Could not load your contribution history. Pull back and try again.
          </Text>
        ) : (
          <>
            {summary ? (
              <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                  Contributed all time
                </Text>
                <Text testID="contribution-lifetime-total" style={[styles.summaryValueLarge, { color: colors.primary }]}>
                  {formatMoney(summary.lifetimeContributedPrincipalCents)}
                </Text>
                <Text style={[styles.summarySub, { color: colors.mutedForeground }]}>
                  {summary.contributionCount} {summary.contributionCount === 1 ? 'drip' : 'drips'} across{' '}
                  {summary.jarCount} {summary.jarCount === 1 ? 'jar' : 'jars'}
                </Text>
                {/*
                  Which of the two numbers is on screen, stated plainly. Once
                  every page is loaded the rows and the total are the same
                  money, and the screen says so rather than staying silent.
                */}
                {showingAll ? (
                  <Text testID="contribution-showing-all" style={[styles.summaryNote, { color: colors.mutedForeground }]}>
                    Showing all {contributions.length} — {formatMoney(loadedTotal)}.
                  </Text>
                ) : (
                  <Text testID="contribution-showing-partial" style={[styles.summaryNote, { color: colors.mutedForeground }]}>
                    Showing the {contributions.length} most recent ({formatMoney(loadedTotal)}). The total above
                    covers all {summary.contributionCount}.
                  </Text>
                )}
              </View>
            ) : null}

            {contributions.length === 0 ? (
              <EmptyState
                icon="droplet"
                title="No contributions yet"
                description="Every drip you make will be listed here."
              />
            ) : (
              <>
                {contributions.map((c, index) => (
                  <Pressable
                    // The API deliberately returns no internal identifier for a
                    // posting, so position within an append-only, newest-first
                    // list is the key. Pages are appended, never reordered, so
                    // an index is stable for a row once it has loaded.
                    key={`${c.jarId}-${c.occurredAt}-${index}`}
                    testID={`contribution-row-${index}`}
                    onPress={() => router.push(`/jar/${c.jarId}`)}
                    style={({ pressed }) => [
                      styles.row,
                      { backgroundColor: colors.card, borderColor: colors.border },
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.jarName, { color: colors.foreground }]} numberOfLines={1}>
                        {c.jarName}
                      </Text>
                      <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                        {formatWhen(c.occurredAt)} · {sourceLabel(c.transactionType)}
                      </Text>
                    </View>
                    <Text style={[styles.amount, { color: colors.foreground }]}>
                      {formatMoney(c.principalCents)}
                    </Text>
                  </Pressable>
                ))}

                {hasNextPage ? (
                  <Pressable
                    testID="contribution-load-more"
                    accessibilityRole="button"
                    disabled={isFetchingNextPage}
                    onPress={() => { void fetchNextPage(); }}
                    style={({ pressed }) => [
                      styles.loadMore,
                      { borderColor: colors.border },
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    {isFetchingNextPage ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : (
                      <Text style={[styles.loadMoreText, { color: colors.primary }]}>Load more</Text>
                    )}
                  </Pressable>
                ) : null}
              </>
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
  summaryLabel: { fontSize: 15 },
  summaryValueLarge: { fontSize: 30, fontWeight: 'bold', marginTop: 4 },
  summarySub: { fontSize: 14, marginTop: 6 },
  summaryNote: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 8,
    gap: 12,
  },
  jarName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  amount: { fontSize: 16, fontWeight: '700' },
  loadMore: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  loadMoreText: { fontSize: 15, fontWeight: '600' },
});
