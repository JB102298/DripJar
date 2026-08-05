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
  unallocatedCents: number;
  surplusCents: number;
  savedPrincipalCents: number;
  committedPrincipalCents: number;
  goalAmountCents: number;
}

export const getJarGoalsQueryKey = (jarId: string) => ['jar-goals', jarId] as const;

export function useJarGoals(jarId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<JarGoalsResponse>({
    queryKey: getJarGoalsQueryKey(jarId ?? ''),
    queryFn: () =>
      customFetch<JarGoalsResponse>(`/jars/${jarId}/goals`),
    enabled: !!jarId && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}
