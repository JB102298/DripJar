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
