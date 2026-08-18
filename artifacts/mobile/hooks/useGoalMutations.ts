/**
 * useGoalMutations — Phase 4D
 *
 * Provides organizer-only goal mutation functions (create, update, archive,
 * reorder) backed by customFetch. Does NOT use react-query — uses plain
 * useState/useCallback for minimal dependency surface, consistent with the
 * commitment screen pattern.
 *
 * Authorization is enforced server-side; these hooks just surface errors.
 */
import { useState, useCallback } from 'react';
import { customFetch } from '@workspace/api-client-react';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateGoalInput {
  name: string;
  targetPrincipalCents: number;
  description?: string | null;
}

export interface UpdateGoalInput {
  name?: string;
  targetPrincipalCents?: number;
  description?: string | null;
}

export interface ReorderResult {
  goals: Array<{ id: string; name: string; sortOrder: number }>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGoalMutations(jarId: string) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const createGoal = useCallback(
    async (input: CreateGoalInput): Promise<unknown> => {
      setSubmitting(true);
      setError(null);
      try {
        return await customFetch<unknown>(`/api/jars/${jarId}/goals`, {
          method: 'POST',
          body: JSON.stringify(input),
        });
      } catch (e: any) {
        setError(e?.message ?? 'Could not create goal');
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [jarId],
  );

  const updateGoal = useCallback(
    async (goalId: string, input: UpdateGoalInput): Promise<unknown> => {
      setSubmitting(true);
      setError(null);
      try {
        return await customFetch<unknown>(`/api/jars/${jarId}/goals/${goalId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        });
      } catch (e: any) {
        setError(e?.message ?? 'Could not update goal');
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [jarId],
  );

  const archiveGoal = useCallback(
    async (goalId: string): Promise<unknown> => {
      setSubmitting(true);
      setError(null);
      try {
        return await customFetch<unknown>(`/api/jars/${jarId}/goals/${goalId}/archive`, {
          method: 'POST',
        });
      } catch (e: any) {
        setError(e?.message ?? 'Could not remove goal');
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [jarId],
  );

  const reorderGoals = useCallback(
    async (goalIds: string[]): Promise<ReorderResult> => {
      setSubmitting(true);
      setError(null);
      try {
        return await customFetch<ReorderResult>(`/api/jars/${jarId}/goals/reorder`, {
          method: 'POST',
          body: JSON.stringify({ goalIds }),
        });
      } catch (e: any) {
        setError(e?.message ?? 'Could not reorder goals');
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [jarId],
  );

  return { submitting, error, clearError, createGoal, updateGoal, archiveGoal, reorderGoals };
}
