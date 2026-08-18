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

export type JarTab = 'Active' | 'Invited' | 'Completed' | 'Archived';

export const JAR_TABS: JarTab[] = ['Active', 'Invited', 'Completed', 'Archived'];

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

export const COMPLETED_JAR_STATUSES: JarStatus[] = [JarStatus.Completed];

export const ARCHIVED_JAR_STATUSES: JarStatus[] = [JarStatus.Cancelled];

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
    case 'Archived':
      return ARCHIVED_JAR_STATUSES.join(',');
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
