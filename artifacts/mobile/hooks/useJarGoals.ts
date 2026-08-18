/**
 * useJarGoals — Phase 4D
 * Fetches active goals with waterfall allocations for a jar.
 * Mounted on the Overview tab (enabled when jar ID is available).
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';

export interface GoalAllocation {
  id: string;
  name: string;
  description: string | null;
  targetPrincipalCents: number;
  sortOrder: number;
  status: 'active' | 'archived';
  savedAllocatedCents: number;
  committedAllocatedCents: number;
  savedPercent: number;
  committedPercent: number;
  fundingState: 'funded' | 'partially_funded' | 'unfunded';
}

export interface JarGoalsResponse {
  goals: GoalAllocation[];
  /** Whether the authenticated viewer is the jar organizer. */
  isOrganizer: boolean;
  goalAmountCents: number;
  savedPrincipalCents: number;
  committedPrincipalCents: number;
  /** Jar target minus sum of active named goal targets (planning gap). */
  unallocatedTargetCents: number;
  /** Saved principal flowing into the unallocated target bucket (≤ unallocatedTargetCents). */
  savedTowardUnallocatedCents: number;
  /** Saved principal genuinely above the jar target (true over-target). */
  overTargetCents: number;
  // Legacy aliases kept for backward compatibility:
  unallocatedCents: number;
  surplusCents: number;
}

export const getJarGoalsQueryKey = (jarId: string) => ['jar-goals', jarId] as const;

export function useJarGoals(jarId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<JarGoalsResponse>({
    queryKey: getJarGoalsQueryKey(jarId ?? ''),
    queryFn: () =>
      customFetch<JarGoalsResponse>(`/api/jars/${jarId}/goals`),
    enabled: !!jarId && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}
