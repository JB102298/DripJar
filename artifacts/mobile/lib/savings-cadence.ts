/**
 * Savings cadence recommendation.
 *
 * Answers "what does each person need to put in, how often, to reach the goal
 * by the target date". The create-jar flow previously answered this with:
 *
 *     // Let's assume there's 6 months to target date for mockup calculation
 *     const months = 6;
 *
 * The target date was never read. A $25,000 goal roughly two years out
 * therefore recommended $4,167/week, $8,333/2 weeks, and $16,667/month — the
 * six-month figures, about eight times too large. The three cards also
 * rendered one base amount scaled ×1/×2/×4, so the labels did not match their
 * own arithmetic: "monthly" showed four times "weekly" regardless of which
 * option was selected.
 *
 * This module is deliberately pure and dependency-free. The server does not
 * recommend a cadence anywhere today, so there is no second implementation to
 * disagree with. If one is added, promote this file to a shared workspace
 * package rather than reimplementing it — a second copy is exactly how the
 * financial surfaces drifted apart.
 *
 * MEMBER COUNT: `participantCount` is the TOTAL number of people saving,
 * organizer included. The create-jar flow stores only invited emails in
 * `state.invitees`, so callers pass `invitees.length + 1`, matching the
 * existing `totalPeople` in members.tsx and review.tsx. This module never adds
 * the organizer itself — doing so here as well would double-count them.
 *
 * The split is a planning aid, not an obligation: nothing enforces an equal
 * share, and each contributor controls their own money.
 */

export type SavingsFrequency = 'weekly' | 'biweekly' | 'monthly';

export const SAVINGS_FREQUENCIES: readonly SavingsFrequency[] = [
  'weekly',
  'biweekly',
  'monthly',
] as const;

/**
 * Where the target date sits relative to today.
 *
 * Kept separate from the period count on purpose. A target three days out has
 * zero complete weekly or monthly periods but is obviously not overdue, and a
 * target later this month has zero complete calendar months while still being
 * future-dated. Deriving "past due" from periods would mislabel both.
 */
export type TargetDateRelation = 'future' | 'today' | 'past';

export interface CadenceInput {
  /** Jar target in cents. */
  goalAmountCents: number;
  /** TOTAL people saving, organizer included. Minimum 1. */
  participantCount: number;
  /** Usually today. */
  startDate: Date;
  /** When the money is needed. */
  targetDate: Date;
  /** Already-saved principal for this person, if any. Defaults to 0. */
  alreadySavedCents?: number;
}

export interface CadenceRecommendation {
  frequency: SavingsFrequency;
  /** Whole cents to contribute each period. Never negative. */
  amountCents: number;
  /** Contributions used to divide the remainder. Always at least 1. */
  periods: number;
  /**
   * True when fewer than one complete cadence interval remains, so `periods`
   * was floored up to 1 and `amountCents` is the entire remainder as a single
   * payment. Independent of whether the date is past due.
   */
  isSinglePayment: boolean;
}

export interface CadencePlan {
  /** This person's share of the goal, before subtracting what they saved. */
  perPersonTargetCents: number;
  /** Still to save: perPersonTarget − alreadySaved, floored at 0. */
  perPersonRemainingCents: number;
  /** Derived purely from the dates. */
  relation: TargetDateRelation;
  /** Convenience: relation === 'past'. Never inferred from period counts. */
  isPastDue: boolean;
  /** Convenience: relation === 'today'. Due now, but not overdue. */
  isDueToday: boolean;
  /** One recommendation per frequency, so every option shows its own maths. */
  byFrequency: Record<SavingsFrequency, CadenceRecommendation>;
}

const MS_PER_DAY = 86_400_000;

/** Midnight-normalised so a partial day never rounds a period away. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days between two dates. Negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

/**
 * Parse a `YYYY-MM-DD` date as LOCAL midday.
 *
 * `new Date("2026-08-11")` is parsed as UTC, which lands on the 10th in any
 * negative-offset timezone and would silently shift every horizon by a day.
 * Midday rather than midnight so a DST transition cannot push the value into
 * the neighbouring day either.
 *
 * Returns null for missing or malformed input so callers can decide what to
 * show rather than propagating an Invalid Date through the arithmetic.
 */
export function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [year, month, day] = parts as [number, number, number];
  const parsed = new Date(year, month - 1, day, 12, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Classify the target date. This is the ONLY source of past-due truth.
 *
 * Both dates are normalised to midnight first, so a target "later today" reads
 * as today rather than past.
 */
export function classifyTargetDate(startDate: Date, targetDate: Date): TargetDateRelation {
  const days = daysBetween(startDate, targetDate);
  if (days > 0) return 'future';
  if (days === 0) return 'today';
  return 'past';
}

/**
 * Whole calendar months between two dates.
 *
 * Calendar arithmetic, not days/30. Over an 18-year horizon the day-based
 * approximation drifts by months, and it makes the answer depend on which
 * months the range happens to span.
 */
export function monthsBetween(from: Date, to: Date): number {
  const a = startOfDay(from);
  const b = startOfDay(to);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  return months;
}

/**
 * How many COMPLETE cadence intervals fit between the two dates.
 *
 * Legitimately returns 0 for a short but future-dated range — that means "no
 * full interval fits", not "overdue". Callers pair it with
 * classifyTargetDate().
 */
export function periodsBetween(
  frequency: SavingsFrequency,
  from: Date,
  to: Date,
): number {
  if (frequency === 'monthly') return Math.max(0, monthsBetween(from, to));

  const days = daysBetween(from, to);
  if (days <= 0) return 0;
  return Math.floor(days / (frequency === 'weekly' ? 7 : 14));
}

/**
 * Split `totalCents` across `participantCount` people.
 *
 * Rounds up so per-person × people ≥ total: a plan landing slightly over the
 * goal reaches it, one landing under never does.
 */
export function splitPerPerson(totalCents: number, participantCount: number): number {
  const people = Math.max(1, Math.floor(participantCount));
  return Math.ceil(Math.max(0, totalCents) / people);
}

/**
 * Per-period amount for one frequency.
 *
 * Rounds up to whole cents for the same reason as the split: the final payment
 * may be slightly smaller, but the schedule always reaches the goal. Rounding
 * is deterministic — identical inputs always produce identical cents.
 */
export function recommendForFrequency(
  frequency: SavingsFrequency,
  remainingCents: number,
  startDate: Date,
  targetDate: Date,
): CadenceRecommendation {
  const completePeriods = periodsBetween(frequency, startDate, targetDate);

  // Fewer than one full interval — whether the date is days away, today, or
  // already past — collapses to a single payment of the whole remainder.
  // Dividing by 0 or a negative count would produce Infinity or a negative
  // recommendation.
  const isSinglePayment = completePeriods <= 0;
  const periods = Math.max(1, completePeriods);

  return {
    frequency,
    amountCents: Math.ceil(Math.max(0, remainingCents) / periods),
    periods,
    isSinglePayment,
  };
}

/** The full plan: every frequency costed from the same per-person remainder. */
export function buildCadencePlan(input: CadenceInput): CadencePlan {
  const {
    goalAmountCents,
    participantCount,
    startDate,
    targetDate,
    alreadySavedCents = 0,
  } = input;

  const perPersonTargetCents = splitPerPerson(goalAmountCents, participantCount);
  const perPersonRemainingCents = Math.max(
    0,
    perPersonTargetCents - Math.max(0, alreadySavedCents),
  );

  const byFrequency = {} as Record<SavingsFrequency, CadenceRecommendation>;
  for (const frequency of SAVINGS_FREQUENCIES) {
    byFrequency[frequency] = recommendForFrequency(
      frequency,
      perPersonRemainingCents,
      startDate,
      targetDate,
    );
  }

  const relation = classifyTargetDate(startDate, targetDate);

  return {
    perPersonTargetCents,
    perPersonRemainingCents,
    relation,
    isPastDue: relation === 'past',
    isDueToday: relation === 'today',
    byFrequency,
  };
}

/** "/ week", "/ 2 weeks", "/ month" — the unit each amount is quoted in. */
export function frequencyUnitLabel(frequency: SavingsFrequency): string {
  switch (frequency) {
    case 'weekly':
      return '/ week';
    case 'biweekly':
      return '/ 2 weeks';
    case 'monthly':
      return '/ month';
  }
}
