/**
 * Canonical user-facing display name.
 *
 * Owner QA found Home and Members showing "Mom", "Dad", "Brother" while
 * Activity showed "Mary", "Robert", "Tyler" for the same people. Two separate
 * causes, both worth fixing:
 *
 *   1. No shared rule. Every surface picked a field and invented its own
 *      fallback — "A member", "Unknown", "A DripJar member", "Someone", and
 *      plain null were all in use for the same concept. Nothing made them
 *      agree, so they drifted.
 *
 *   2. Names were frozen into activity history. `activity_events.description`
 *      is written once and read for ever, so any name embedded in it is a
 *      snapshot. The seeded history said "Robert added $700.00" while the
 *      profile's display name had since been set to "Dad". Renaming yourself
 *      could never fix the old rows.
 *
 * This module fixes (1). For (2), descriptions must stay name-free and callers
 * should send `actorName` alongside, resolved here at read time — see
 * resolveActorName below.
 *
 * NEVER returns an empty string, null, or an internal identifier. A user id in
 * place of a name is a privacy leak and looks broken; a neutral placeholder is
 * strictly better.
 */

/** The name-bearing fields of a profile. All are NOT NULL in the schema, but
 *  callers frequently hold a partial or missing profile, so every field is
 *  optional here and whitespace-only values are treated as absent. */
export interface NameableProfile {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Shown when no usable name exists — a profile row that is missing, or a
 * system-generated event with no actor.
 *
 * Deliberately generic. The alternative of falling back to an email or user id
 * would expose personal data to every other member of a jar.
 */
export const UNKNOWN_DISPLAY_NAME = "A DripJar member";

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The one rule, in precedence order:
 *
 *   1. `displayName` — what the person chose to be called. A nickname like
 *      "Mom" is the correct answer when they set it; it is not a data problem.
 *   2. `firstName lastName` — for profiles predating the display-name field.
 *   3. whichever single name part exists.
 *   4. UNKNOWN_DISPLAY_NAME.
 */
export function resolveDisplayName(profile: NameableProfile | null | undefined): string {
  if (!profile) return UNKNOWN_DISPLAY_NAME;

  const display = clean(profile.displayName);
  if (display) return display;

  const first = clean(profile.firstName);
  const last = clean(profile.lastName);
  if (first && last) return `${first} ${last}`;

  return first ?? last ?? UNKNOWN_DISPLAY_NAME;
}

/**
 * Compact form for avatars, chips, and dense member lists.
 *
 * The first whitespace-delimited token of the canonical name, so "Jordan
 * Barrett" shortens to "Jordan" while "Mom" stays "Mom". Callers were doing
 * `displayName.split(' ')[0]` inline, which threw on a null name and produced
 * an empty label for a name starting with a space.
 */
export function resolveShortDisplayName(profile: NameableProfile | null | undefined): string {
  const full = resolveDisplayName(profile);
  // The placeholder is a phrase, not a name — truncating it yields "A".
  if (full === UNKNOWN_DISPLAY_NAME) return UNKNOWN_DISPLAY_NAME;
  return full.split(/\s+/)[0] || UNKNOWN_DISPLAY_NAME;
}

/**
 * Actor name for an activity or notification entry.
 *
 * Separate from resolveDisplayName only to make the null case explicit:
 * some events genuinely have no actor (`user_id IS NULL` for system events
 * such as "Flights are fully funded!"). Those return null so the client can
 * omit the actor entirely rather than captioning a system event
 * "A DripJar member".
 */
export function resolveActorName(
  profile: NameableProfile | null | undefined,
  hasActor: boolean,
): string | null {
  if (!hasActor) return null;
  return resolveDisplayName(profile);
}
