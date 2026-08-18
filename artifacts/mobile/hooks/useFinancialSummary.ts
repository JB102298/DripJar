/**
 * useFinancialSummary — Phase 4D
 * Fetches the jar-level financial summary with goal waterfall and privacy-scoped member details.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import type { GoalAllocation } from './useJarGoals';

export interface JarFinancials {
  jarId: string;
  goalAmountCents: number;
  currency: string;
  savedPrincipalCents: number;
  committedPrincipalCents: number;
  refundablePrincipalCents: number;
  refundPendingCents: number;
  refundedLifetimeCents: number;
  remainingToSaveCents: number;
  dripJarFeesTotalCents: number;
  processingFeesTotalCents: number;
  savedPercent: number;
  committedPercent: number;
  isOverTarget: boolean;
  overTargetByCents: number;
}

export interface MemberFinancialSummary {
  memberId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isOwnData: boolean;
  statusLabel: string;
  savedPercent: number;
  // Present only for own data or organizer view
  contributedPrincipalCents?: number;
  refundablePrincipalCents?: number;
  refundPendingCents?: number;
  committedPrincipalCents?: number;
  refundedPrincipalCents?: number;
  savedPrincipalCents?: number;
  dripJarFeesEarnedCents?: number;
  processingFeesEstimatedCents?: number;
}

export interface FinancialSummaryResponse {
  jar: JarFinancials;
  goals: GoalAllocation[];
  /** Jar target minus sum of active named goal targets (planning gap). */
  unallocatedTargetCents: number;
  /** Saved principal flowing into the unallocated target bucket. */
  savedTowardUnallocatedCents: number;
  /** Saved principal genuinely above the jar target. */
  overTargetCents: number;
  // Legacy aliases:
  unallocatedCents: number;
  surplusCents: number;
  members: MemberFinancialSummary[];
  viewerRole: 'organizer' | 'member';
  invariantHolds: boolean;
}

export const getFinancialSummaryQueryKey = (jarId: string) =>
  ['jar-financial-summary', jarId] as const;

export function useFinancialSummary(jarId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<FinancialSummaryResponse>({
    queryKey: getFinancialSummaryQueryKey(jarId ?? ''),
    queryFn: () =>
      customFetch<FinancialSummaryResponse>(`/api/jars/${jarId}/financial-summary`),
    enabled: !!jarId && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}
