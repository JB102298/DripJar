import { jarToday } from "./jar-time.js";
/**
 * Canonical jar lifecycle statuses and query-filter parsing.
 *
 * `jars.status` is a plain `text` column, so nothing at the database level
 * constrains it. This module is the single place that says which values are
 * real, and it must stay in sync with the `JarStatus` enum in
 * `lib/api-spec/openapi.yaml`.
 *
 * WHY THIS EXISTS — Owner QA item 10. `GET /jars` filtered with exact string
 * equality (`j.status === status`) while the My Jars "Active" tab sent the
 * comma-separated `"Saving,FullyFunded"`. No stored status equals that string,
 * so the Active tab returned an empty list for every user, and the failure was
 * silent: an unrecognised filter looked identical to "you have no jars".
 *
 * Two properties fix that class of bug for good:
 *
 *   1. The filter is a SET, not a string. Multiple statuses are legitimate.
 *   2. An unrecognised status is a 400, never an empty result. A typo or a
 *      stale client is now loud instead of masquerading as an empty account.
 */

/** Every status a jar row may legitimately hold. Order matches the spec enum. */
export const JAR_STATUSES = [
  "Draft",
  "Inviting",
  "Saving",
  "CommitmentPending",
  "Committed",
  "FullyFunded",
  "Completed",
  "Cancelled",
] as const;

export type JarStatusValue = (typeof JAR_STATUSES)[number];

const JAR_STATUS_SET: ReadonlySet<string> = new Set(JAR_STATUSES);

export function isJarStatus(value: string): value is JarStatusValue {
  return JAR_STATUS_SET.has(value);
}

export type StatusFilterResult =
  /** `statuses: null` means "no filter" — return every jar in scope. */
  | { ok: true; statuses: JarStatusValue[] | null }
  | { ok: false; invalid: string[] };

/**
 * Parse the `status` query parameter into a set of statuses to match.
 *
 * Accepts both wire forms the client can produce:
 *   - `?status=Saving,FullyFunded`      (comma-separated — what orval emits,
 *                                        since URLSearchParams stringifies an
 *                                        array to a comma-joined value)
 *   - `?status=Saving&status=FullyFunded` (Express hands this over as an array)
 *
 * Blank segments are dropped and duplicates collapse, so `",Saving,,Saving,"`
 * is the same filter as `"Saving"`. A parameter that is absent, empty, or all
 * blanks means "no filter" rather than "match nothing" — an empty `IN ()` would
 * silently hide every jar, which is the bug this module exists to prevent.
 */
export function parseStatusFilter(raw: unknown): StatusFilterResult {
  if (raw === undefined || raw === null) return { ok: true, statuses: null };

  const rawParts = Array.isArray(raw) ? raw : [raw];
  const tokens: string[] = [];
  for (const part of rawParts) {
    if (typeof part !== "string") continue;
    for (const token of part.split(",")) {
      const trimmed = token.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }

  if (tokens.length === 0) return { ok: true, statuses: null };

  const invalid = [...new Set(tokens.filter((t) => !isJarStatus(t)))];
  if (invalid.length > 0) return { ok: false, invalid };

  return { ok: true, statuses: [...new Set(tokens)] as JarStatusValue[] };
}

/** Human-readable 400 body for a rejected `status` filter. */
export function invalidStatusMessage(invalid: string[]): string {
  return (
    `Unknown jar status: ${invalid.join(", ")}. ` +
    `Valid statuses are: ${JAR_STATUSES.join(", ")}.`
  );
}

// ─── Lifecycle gate for new money-in actions ─────────────────────────────────

/**
 * Statuses whose lifecycle permits *initiating* a new contribution.
 *
 * This is the single server-side answer to "does this jar's state allow new
 * money in?". Every route that can create a payment intent, a quote, an
 * AutoDrip authorisation, or a contribution row asks this — none of them keeps
 * its own status array. Before this existed, `POST /jars/:id/contributions`
 * inlined `["Saving", "CommitmentPending"]` while
 * `POST /jars/:id/drips/payment-intent` and `POST /finance/quote` selected only
 * `jars.id` and never looked at status at all, so the legacy path refused a
 * cancelled jar and the two real money paths accepted it.
 *
 * ─── NECESSARY, NOT SUFFICIENT ───────────────────────────────────────────────
 *
 * A `true` here means only that the jar is not in a state that forbids
 * contributing. It is not permission. Authentication, membership, acceptance of
 * the current agreement, payment readiness, amount validation, idempotency, and
 * rate limiting are all still independently required by the routes that call
 * this. Callers must treat a `true` as "keep checking", never as "allow".
 *
 * ─── FAILS CLOSED ────────────────────────────────────────────────────────────
 *
 * Membership of this set is explicit. A terminal status, an unrecognised legacy
 * value, an empty string, or a status the server gains before this list is
 * updated all return `false`. New money into a jar nobody can classify is the
 * outcome worth preventing.
 *
 * ─── WHAT THIS DOES NOT GATE ─────────────────────────────────────────────────
 *
 * Settlement. A payment intent legitimately created while the jar was still
 * active can settle after cancellation, and that webhook must still post
 * canonically — dropping it would lose money that already left the member's
 * card. Once posted it is ordinary uncommitted principal and stays refundable.
 * `POST /webhooks/stripe` therefore does not consult this predicate.
 *
 * Refunds. Money *out* is never a function of jar status; see
 * `routes/refunds.ts`.
 */
const CONTRIBUTION_LIFECYCLE_STATUSES: ReadonlySet<string> = new Set<string>([
  "Saving",
  "CommitmentPending",
]);

/**
 * True when the jar's lifecycle status alone does not forbid a new
 * contribution. See the caveats above — this is one input to authorization,
 * not the decision.
 */
export function lifecycleAllowsNewContribution(status: string | null | undefined): boolean {
  if (typeof status !== "string") return false;
  return CONTRIBUTION_LIFECYCLE_STATUSES.has(status);
}

/** Human-readable refusal, so every route rejects with the same wording. */
export function contributionLifecycleMessage(status: string | null | undefined): string {
  const shown = typeof status === "string" && status.length > 0 ? status : "unknown";
  return `This jar is not accepting contributions (status: ${shown}).`;
}

// ─── Lifecycle gate for confirming a fund commitment ─────────────────────────

/**
 * Whether the jar's lifecycle permits a member to CONFIRM a fund commitment.
 *
 * Committing is not contributing, and this must never reuse
 * `lifecycleAllowsNewContribution`. Contributing adds new money to a jar;
 * committing converts principal the member has ALREADY paid in from refundable
 * to non-refundable. The second act is the one that can strand somebody's
 * savings, so its gate is narrower, not wider.
 *
 * ─── THE CANONICAL WINDOW ────────────────────────────────────────────────────
 *
 * Exactly one status qualifies, and only alongside a date condition:
 *
 *     status === "Saving"  AND  cutoffDate is set  AND  jarToday(tz) >= cutoffDate
 *
 * That is the window `routes/fund-commitment.ts` has always required (what
 * `deriveJarPhase` calls the "Commitment" phase). Two differences from the old
 * inline check, both deliberate:
 *
 *   1. It is an allowlist of statuses, not a comparison against a derived phase
 *      string, so renaming a phase cannot silently widen it.
 *   2. The date is evaluated in the jar's own immutable timezone rather than
 *      the server's UTC date. See `jarToday`.
 *
 * ─── DEFECT 1: `CommitmentPending` IS A ONE-WAY STATE ────────────────────────
 *
 * `CommitmentPending` is deliberately absent, and that is a known, documented
 * defect rather than an oversight.
 *
 * `POST /jars/:id/commitments` (the group commitment REQUEST) sets
 * `jars.status = "CommitmentPending"`, and nothing anywhere sets it back: the
 * only write of `"Saving"` in the whole server is the `Draft -> Saving` launch.
 * `deriveJarPhase` has no case for it either, so it falls through unchanged.
 * The consequence is that opening a group request permanently disables
 * individual fund commitment for that jar.
 *
 * Meanwhile `fund-commitment.ts` never reads `commitment_requests` at all, so
 * individual confirmation has never required an approved group request. The two
 * workflows are disconnected, and the group one dead-ends.
 *
 * Adding `CommitmentPending` here would "fix" the dead end by letting a member
 * commit merely because the organizer OPENED a request — no approval required —
 * which is worse than the dead end. Connecting the two properly is a
 * state-machine design change and is out of scope for this correction.
 *
 * NECESSARY, NOT SUFFICIENT. Membership, snapshot ownership, agreement
 * acceptance, snapshot freshness, and idempotency remain independently checked.
 */
const FUND_COMMITMENT_LIFECYCLE_STATUSES: ReadonlySet<string> = new Set<string>(["Saving"]);

export function lifecycleAllowsFundCommitment(
  status: string | null | undefined,
  cutoffDate: string | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (typeof status !== "string") return false;
  if (!FUND_COMMITMENT_LIFECYCLE_STATUSES.has(status)) return false;
  if (typeof cutoffDate !== "string" || cutoffDate.length === 0) return false;

  // Jar Time, not server UTC. `null` means the zone could not be resolved, and
  // an unevaluatable date gate must refuse rather than guess.
  const today = jarToday(timeZone, now);
  if (today === null) return false;

  // ISO date strings compare lexicographically in chronological order.
  return today >= cutoffDate;
}

/** Refusal wording for the fund-commitment gate. */
export function fundCommitmentLifecycleMessage(status: string | null | undefined): string {
  const shown = typeof status === "string" && status.length > 0 ? status : "unknown";
  if (shown === "Cancelled" || shown === "Completed") {
    return `This jar is ${shown.toLowerCase()}. Funds can no longer be committed.`;
  }
  return `This jar is not in its commitment window (status: ${shown}).`;
}
