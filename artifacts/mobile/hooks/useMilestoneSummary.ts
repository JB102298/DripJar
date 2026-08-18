/**
 * useMilestoneSummary — Owner QA item 3
 *
 * `GET /jars/:jarId/milestones` returns a bare array, so it has nowhere to
 * carry the jar-level totals needed to prove the per-milestone figures add up.
 * `GET /jars/:jarId/milestones/summary` is its additive sibling and carries
 * them. See api-server/src/routes/milestones.ts.
 *
 * Why the screen needs this at all: Hawaii 2027 listed $5,778 across five
 * milestones while the jar held $7,274 saved. The $1,496 gap was legitimate —
 * five contributions carried no milestone tag — but nothing on screen named it,
 * so the only available reading was that money had gone missing.
 *
 * Hand-written rather than orval-generated for the same reason as
 * `useFinancialSummary` and `useJarGoals`: the endpoint is not yet described in
 * lib/api-spec/openapi.yaml. Adding it there and regenerating is the tidier
 * long-term home for this.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';

export interface MilestoneSummaryResponse {
  jarId: string;
  goalAmountCents: number;
  /** Canonical saved principal from the ledger — the number every surface must agree with. */
  savedPrincipalCents: number;
  /** Sum of saved principal attributed to a specific milestone. */
  totalAllocatedCents: number;
  /**
   * Saved principal not attributed to any milestone, derived as the residual
   * `savedPrincipalCents − totalAllocatedCents`. Never negative.
   */
  unallocatedCents: number;
  /**
   * False when milestone attribution exceeded canonical saved principal. The
   * split is then wrong, not merely coarse, and the UI must suppress every
   * per-milestone figure rather than render numbers that do not add up.
   */
  reconciles: boolean;
}

export const getMilestoneSummaryQueryKey = (jarId: string) =>
  ['jar-milestone-summary', jarId] as const;

export function useMilestoneSummary(jarId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<MilestoneSummaryResponse>({
    queryKey: getMilestoneSummaryQueryKey(jarId ?? ''),
    queryFn: () =>
      customFetch<MilestoneSummaryResponse>(`/api/jars/${jarId}/milestones/summary`),
    enabled: !!jarId && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}

/**
 * Whether the per-milestone breakdown is safe to display.
 *
 * Deliberately conservative: while the summary is still loading, or if the
 * request failed, the answer is "no". Showing per-milestone amounts that the
 * screen cannot yet prove reconcile is exactly the failure this exists to stop,
 * and a missing summary is not evidence that the split is sound.
 */
export function canShowAllocationBreakdown(
  summary: MilestoneSummaryResponse | undefined,
): summary is MilestoneSummaryResponse {
  return summary !== undefined && summary.reconciles;
}
