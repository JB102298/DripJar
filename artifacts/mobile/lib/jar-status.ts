/**
 * My Jars tab → jar status mapping.
 *
 * Owner QA item 10: a jar created from the create-jar flow never appeared in
 * My Jars. Two things were wrong at once.
 *
 *   1. The Active tab sent the literal string `"Saving,FullyFunded"` while the
 *      API compared it with `===` against a single stored status. Nothing
 *      matched, so Active was empty for every user — not just for new jars.
 *   2. `POST /jars` stores new jars as `Draft`, and no tab covered `Draft`, so
 *      even with a working filter a freshly created jar had nowhere to land.
 *
 * The fix keeps `Draft` as the stored status — a jar is genuinely not launched
 * yet, and auto-promoting it to `Saving` just to make it visible would start a
 * savings schedule the organizer never agreed to. Instead, Active means "not
 * finished and not cancelled", which is what a person means by "my jars".
 *
 * `JarStatus` is generated from lib/api-spec/openapi.yaml, so ACTIVE_JAR_STATUSES
 * is expressed in terms of it rather than as loose strings; a status renamed in
 * the spec becomes a type error here instead of another silently empty tab.
 */
// `JarStatus` is exported as both a const map and a union type, so the single
// import serves for the values below and their annotation.
import { JarStatus } from '@workspace/api-client-react';

/**
 * THERE IS NO ARCHIVE.
 *
 * The fourth tab used to be called "Archived" and was defined as
 * `[JarStatus.Cancelled]` — the label was the only thing archive-shaped about
 * it. Nothing in the product archives a jar: `jars` has no `archived` status,
 * no `archived_at` column, and no archive endpoint. The Disney jar showed up
 * under "Archived" because it was cancelled, and cancelled was what that tab
 * queried.
 *
 * Calling a cancelled jar "archived" is not a cosmetic slip. Archiving reads as
 * reversible tidying-up; cancelling is terminal, and nothing in the product can
 * undo it. The tab is now named for what it actually contains.
 *
 * If a real archive concept is ever introduced it needs its own status, its own
 * transition, and its own tab — not a rename of this one.
 */
export type JarTab = 'Active' | 'Invited' | 'Completed' | 'Cancelled';

export const JAR_TABS: JarTab[] = ['Active', 'Invited', 'Completed', 'Cancelled'];

/**
 * Every status a jar can hold while it is still live.
 *
 * Draft    — created, not yet launched (still the organizer's to shape)
 * Inviting — organizer is recruiting members
 * Saving   — contributions are being collected
 * CommitmentPending / Committed — funds are being locked to a purpose
 * FullyFunded — goal reached, jar not yet closed out
 *
 * Completed and Cancelled are deliberately absent: they are terminal and have
 * their own tabs.
 */
export const ACTIVE_JAR_STATUSES: JarStatus[] = [
  JarStatus.Draft,
  JarStatus.Inviting,
  JarStatus.Saving,
  JarStatus.CommitmentPending,
  JarStatus.Committed,
  JarStatus.FullyFunded,
];

/**
 * `Completed` is declared in the spec enum but is never written by any code
 * path — no route, no automation, no script sets it. The tab is therefore
 * always empty today. It is kept because completion is a real intended state
 * and the enum promises it; the gap is that nothing implements the transition.
 */
export const COMPLETED_JAR_STATUSES: JarStatus[] = [JarStatus.Completed];

export const CANCELLED_JAR_STATUSES: JarStatus[] = [JarStatus.Cancelled];

/**
 * The `status` query value for a tab, or `undefined` when the tab is not backed
 * by `GET /jars` at all.
 *
 * `Invited` returns undefined by design: an invitation you have not accepted is
 * membership state, not jar lifecycle state, and `GET /jars` only returns jars
 * you already organize or actively belong to. That tab reads `GET /invitations`
 * instead — see `pendingInvitations`.
 */
export function statusParamForTab(tab: JarTab): string | undefined {
  switch (tab) {
    case 'Active':
      return ACTIVE_JAR_STATUSES.join(',');
    case 'Completed':
      return COMPLETED_JAR_STATUSES.join(',');
    case 'Cancelled':
      return CANCELLED_JAR_STATUSES.join(',');
    case 'Invited':
      return undefined;
  }
}

/** Minimal shape of an invitation for tab filtering — matches InvitationWithJar. */
type InvitationLike = {
  status: string;
  expiresAt: string;
};

/**
 * Invitations the user can still act on.
 *
 * `GET /invitations` returns the caller's full invitation history — accepted,
 * declined, revoked and expired rows included. Only `pending` invitations that
 * have not lapsed represent an outstanding decision, so only those belong in
 * the Invited tab.
 *
 * The expiry check is repeated client-side on purpose: the server marks a row
 * `expired` lazily, so a `pending` row whose `expiresAt` has passed is still
 * possible and must not be offered as actionable.
 */
export function pendingInvitations<T extends InvitationLike>(
  invitations: T[] | undefined,
  now: Date = new Date(),
): T[] {
  if (!invitations) return [];
  return invitations.filter(
    (inv) => inv.status === 'pending' && new Date(inv.expiresAt).getTime() > now.getTime(),
  );
}

// ─── Lifecycle presentation model ────────────────────────────────────────────

/**
 * One place that answers "what may this jar's UI say?".
 *
 * Owner QA found a cancelled jar still advertising "23 days left" and an
 * "At Risk" badge. That was not one bug on one card — every surface decided for
 * itself with its own `status === '...'` conditional, so each had to be found
 * separately and the next surface added would get it wrong again. The card, the
 * detail screen, and anything added later read this instead.
 *
 * ─── WHAT THIS MODEL DELIBERATELY DOES NOT DECIDE ────────────────────────────
 *
 * Refund eligibility. It is not a function of `jar.status` and must never be
 * derived from one here. The canonical source is the refund service:
 * `getRefundableLots` (settled, posted, uncommitted contribution lots, minus
 * anything already committed), surfaced by `GET /jars/:id/refunds/preview`.
 * That query does not look at the jar's status at all, and it is right not to —
 * a member's uncommitted principal is theirs whether or not the organizer
 * cancelled the jar.
 *
 * A cancelled jar therefore keeps its refund affordance, driven by the previewed
 * balance rather than by the status. Encoding `canRefund: false` for cancelled
 * jars here would have hard-coded stranded funds into the design.
 */
export interface JarLifecycle {
  /** The stored status, echoed back so callers need not re-read it. */
  status: string;
  /** Short user-facing state name. */
  label: string;
  /** My Jars bucket, or `null` for a status this build does not recognise. */
  bucket: 'Active' | 'Completed' | 'Cancelled' | null;
  /** Still moving through the lifecycle. */
  isActive: boolean;
  /** Terminal: no further lifecycle transitions are supported. */
  isTerminal: boolean;
  /** A countdown to the target date still means something. */
  showCountdown: boolean;
  /** Savings health / risk still means something. */
  showHealth: boolean;
  /**
   * Which lifecycle date the UI may display.
   *
   * `'target'` — the goal date, for jars still working toward it.
   * `'none'`   — a terminal jar. `jars` stores no `cancelled_at` or
   *              `completed_at`, and the Jar API exposes only `updatedAt`,
   *              which every unrelated edit touches. Rendering that as "date
   *              cancelled" would invent a fact, so terminal jars show their
   *              status and no date until a real column exists.
   */
  dateToShow: 'target' | 'none';
  /**
   * Whether the jar's LIFECYCLE STATUS alone permits new contributions —
   * mirroring the status half of the server's gate in
   * `POST /jars/:id/contributions` (`Saving` or `CommitmentPending`).
   *
   * NECESSARY, NOT SUFFICIENT. A `true` here means only that the jar is not in
   * a state that forbids contributing. It is not permission to contribute and
   * must never be treated as the final answer. The server additionally
   * requires, at minimum:
   *
   *   - authorization (a valid session for the caller)
   *   - active membership in this jar
   *   - acceptance of the jar's current agreement version
   *   - payment readiness (a usable payment method, a valid quote)
   *   - amount, idempotency, and rate-limit checks
   *
   * Any of those can refuse a contribution while this field is `true`. Callers
   * use it to hide an action that is definitely invalid, never to conclude that
   * an action is definitely valid — the server remains the only authority.
   *
   * Named for what it measures so that a future reader cannot mistake it for
   * an eligibility verdict.
   */
  lifecycleAllowsContributions: boolean;
  /** One line explaining a terminal state, or `null` when still active. */
  terminalCopy: string | null;
}

const ACTIVE_SET: ReadonlySet<string> = new Set<string>(ACTIVE_JAR_STATUSES);

/** Statuses whose lifecycle does not forbid a new contribution. */
const CONTRIBUTABLE: ReadonlySet<string> = new Set<string>([
  JarStatus.Saving,
  JarStatus.CommitmentPending,
]);

/**
 * Classify a jar for presentation.
 *
 * An unrecognised status — a legacy row, or one the server gained before this
 * client knew about it — is treated as neither active nor terminal: no bucket,
 * no countdown, no health badge, no contribute action. Failing closed keeps an
 * unknown jar out of the Active tab instead of letting it inherit active
 * affordances by default.
 */
export function describeJarLifecycle(jar: { status: string }): JarLifecycle {
  const status = jar.status;

  if (status === JarStatus.Cancelled) {
    return {
      status,
      label: 'Cancelled',
      bucket: 'Cancelled',
      isActive: false,
      isTerminal: true,
      showCountdown: false,
      showHealth: false,
      dateToShow: 'none',
      lifecycleAllowsContributions: false,
      terminalCopy: 'This jar was cancelled. No further contributions are recorded.',
    };
  }

  if (status === JarStatus.Completed) {
    return {
      status,
      label: 'Completed',
      bucket: 'Completed',
      isActive: false,
      isTerminal: true,
      showCountdown: false,
      showHealth: false,
      dateToShow: 'none',
      lifecycleAllowsContributions: false,
      terminalCopy: 'This jar is complete. Its history stays available here.',
    };
  }

  if (ACTIVE_SET.has(status)) {
    return {
      status,
      label:
        status === JarStatus.FullyFunded
          ? 'Fully funded'
          : status === JarStatus.CommitmentPending
            ? 'Commitment'
            : status,
      bucket: 'Active',
      isActive: true,
      isTerminal: false,
      showCountdown: true,
      showHealth: true,
      dateToShow: 'target',
      lifecycleAllowsContributions: CONTRIBUTABLE.has(status),
      terminalCopy: null,
    };
  }

  // Unknown / legacy value — fail closed.
  return {
    status,
    label: status,
    bucket: null,
    isActive: false,
    isTerminal: false,
    showCountdown: false,
    showHealth: false,
    dateToShow: 'none',
    lifecycleAllowsContributions: false,
    terminalCopy: null,
  };
}
