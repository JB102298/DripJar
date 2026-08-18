/**
 * Canonical user-facing display name — client mirror.
 *
 * The API resolves names server-side (artifacts/api-server/src/lib/display-name.ts)
 * and every list endpoint now returns an already-resolved string. This module
 * exists for the places the client still holds a raw profile — the signed-in
 * user's own profile on the greeting and profile screens — and for the compact
 * form used by avatars and chips.
 *
 * The rule must match the server's. Screens previously each improvised:
 *
 *     profile?.firstName || 'Traveler'
 *     profile?.displayName || 'Traveler'
 *     profile?.displayName || `${profile?.firstName} ${profile?.lastName}`
 *     member.profile?.displayName || 'Unknown'
 *     member.displayName.split(' ')[0]
 *
 * Five renderings of one concept, one of which prints the string "undefined
 * undefined" when a profile is partially loaded, and one of which throws on a
 * null name.
 */

export interface NameableProfile {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Shown when no usable name exists. Matches the server constant.
 *
 * Never falls back to an email or user id — that would leak personal data to
 * every other member of a jar.
 */
export const UNKNOWN_DISPLAY_NAME = 'A DripJar member';

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Precedence: chosen display name → first + last → whichever part exists →
 * placeholder. A nickname like "Mom" is the correct answer when the person set
 * it, not a data problem to work around.
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
 * Compact form for avatars, chips, and dense member lists: the first token of
 * the canonical name. "Jordan Barrett" → "Jordan"; "Mom" → "Mom".
 *
 * Accepts an already-resolved string as well as a profile, because most list
 * endpoints now return the resolved name rather than the raw fields.
 */
export function shortDisplayName(
  nameOrProfile: string | NameableProfile | null | undefined,
): string {
  const full =
    typeof nameOrProfile === 'string'
      ? clean(nameOrProfile) ?? UNKNOWN_DISPLAY_NAME
      : resolveDisplayName(nameOrProfile);

  // The placeholder is a phrase, not a name — truncating it yields "A".
  if (full === UNKNOWN_DISPLAY_NAME) return UNKNOWN_DISPLAY_NAME;
  return full.split(/\s+/)[0] || UNKNOWN_DISPLAY_NAME;
}

/**
 * Greeting form: a first name where one exists, otherwise the compact name.
 *
 * Kept distinct from shortDisplayName so "Good morning, A DripJar member" can
 * never happen — an unnamed profile gets a warm generic instead.
 */
export function greetingName(
  profile: NameableProfile | null | undefined,
  fallback = 'there',
): string {
  const first = clean(profile?.firstName);
  if (first) return first;

  const display = clean(profile?.displayName);
  if (display) return display.split(/\s+/)[0] ?? fallback;

  return fallback;
}
