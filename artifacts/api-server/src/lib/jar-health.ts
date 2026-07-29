export type HealthStatus = "Ahead" | "OnTrack" | "NeedsAttention" | "AtRisk";

export interface JarHealthResult {
  status: HealthStatus;
  message: string;
  actualPercentage: number;
  expectedPercentage: number;
  daysElapsed: number;
  totalDays: number;
  amountBehindCents: number;
  estimatedCompletionDate: string | null;
}

// Configurable thresholds (percentage points ahead/behind)
const THRESHOLDS = {
  aheadMin: 10,
  onTrackMin: -10,
  needsAttentionMin: -20,
} as const;

export function calculateJarHealth(
  goalAmountCents: number,
  totalSavedCents: number,
  launchedAt: Date,
  targetDate: Date,
): JarHealthResult {
  const now = new Date();
  const totalMs = targetDate.getTime() - launchedAt.getTime();
  const elapsedMs = Math.max(0, now.getTime() - launchedAt.getTime());

  const totalDays = Math.max(1, Math.ceil(totalMs / 86_400_000));
  const daysElapsed = Math.ceil(elapsedMs / 86_400_000);

  const expectedPercentage = Math.min(100, (daysElapsed / totalDays) * 100);
  const actualPercentage =
    goalAmountCents > 0
      ? Math.min(100, (totalSavedCents / goalAmountCents) * 100)
      : 0;

  const diff = actualPercentage - expectedPercentage;

  let status: HealthStatus;
  if (diff >= THRESHOLDS.aheadMin) status = "Ahead";
  else if (diff >= THRESHOLDS.onTrackMin) status = "OnTrack";
  else if (diff >= THRESHOLDS.needsAttentionMin) status = "NeedsAttention";
  else status = "AtRisk";

  const expectedAmountCents = Math.round(
    (expectedPercentage / 100) * goalAmountCents,
  );
  const amountBehindCents = Math.max(0, expectedAmountCents - totalSavedCents);
  const amountAheadCents = Math.max(0, totalSavedCents - expectedAmountCents);

  let message = "";
  if (status === "Ahead") {
    const daysAhead = Math.round((amountAheadCents / goalAmountCents) * totalDays);
    message =
      daysAhead > 0
        ? `Your group is on track to reach the goal ${daysAhead} days early.`
        : "Your group is ahead of schedule!";
  } else if (status === "OnTrack") {
    message = "Your group is on track to reach the goal.";
  } else if (status === "NeedsAttention") {
    const behindDollars = Math.round(amountBehindCents / 100);
    message = `Your group is approximately $${behindDollars} behind the current savings target.`;
  } else {
    const behindDollars = Math.round(amountBehindCents / 100);
    message = `Your group is $${behindDollars} behind schedule. Consider increasing contributions soon.`;
  }

  // Estimate completion date based on current daily saving rate
  let estimatedCompletionDate: string | null = null;
  if (totalSavedCents > 0 && daysElapsed > 0 && totalSavedCents < goalAmountCents) {
    const dailyRate = totalSavedCents / daysElapsed;
    const remainingCents = goalAmountCents - totalSavedCents;
    const daysToComplete = Math.ceil(remainingCents / dailyRate);
    const completionDate = new Date(now);
    completionDate.setDate(completionDate.getDate() + daysToComplete);
    estimatedCompletionDate = completionDate.toISOString().split("T")[0]!;
  }

  return {
    status,
    message,
    actualPercentage,
    expectedPercentage,
    daysElapsed,
    totalDays,
    amountBehindCents,
    estimatedCompletionDate,
  };
}

export function calculateMemberHealth(
  contributionTargetCents: number,
  contributedAmountCents: number,
  daysElapsed: number,
  totalDays: number,
): "Ahead" | "OnTrack" | "NeedsAttention" | "AtRisk" | "NotStarted" {
  if (contributedAmountCents === 0) return "NotStarted";

  const expectedPercentage = Math.min(100, (daysElapsed / Math.max(1, totalDays)) * 100);
  const actualPercentage =
    contributionTargetCents > 0
      ? Math.min(100, (contributedAmountCents / contributionTargetCents) * 100)
      : 0;

  const diff = actualPercentage - expectedPercentage;

  if (diff >= THRESHOLDS.aheadMin) return "Ahead";
  if (diff >= THRESHOLDS.onTrackMin) return "OnTrack";
  if (diff >= THRESHOLDS.needsAttentionMin) return "NeedsAttention";
  return "AtRisk";
}
