/**
 * Legal document URLs.
 *
 * DripJar does not host or bundle legal text — the Privacy Policy and Terms of
 * Service are published externally and linked to. These URLs are supplied at
 * build time through the same `EXPO_PUBLIC_*` convention already used for
 * `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
 *
 * Deliberately unset by default. No placeholder or example URL is provided:
 * a link that resolves to the wrong page is worse than a link that is visibly
 * unavailable, and inventing one would misrepresent legal terms that do not
 * exist yet. Screens must treat an unconfigured URL as "not available" rather
 * than rendering a dead link.
 *
 * To enable, set both before building:
 *   EXPO_PUBLIC_PRIVACY_POLICY_URL=https://<host>/privacy
 *   EXPO_PUBLIC_TERMS_OF_SERVICE_URL=https://<host>/terms
 */

export const PRIVACY_POLICY_ENV_VAR = 'EXPO_PUBLIC_PRIVACY_POLICY_URL';
export const TERMS_OF_SERVICE_ENV_VAR = 'EXPO_PUBLIC_TERMS_OF_SERVICE_URL';

/** A legal link: its URL (empty when unset) and whether it can be opened. */
export interface LegalLink {
  url: string;
  envVar: string;
  configured: boolean;
}

/**
 * Only absolute http(s) URLs are accepted. A relative or malformed value is
 * treated as unconfigured rather than handed to the OS URL opener.
 */
function buildLink(rawUrl: string | undefined, envVar: string): LegalLink {
  const url = (rawUrl ?? '').trim();
  const configured = /^https?:\/\/\S+$/i.test(url);
  return { url: configured ? url : '', envVar, configured };
}

export const privacyPolicyLink: LegalLink = buildLink(
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  PRIVACY_POLICY_ENV_VAR,
);

export const termsOfServiceLink: LegalLink = buildLink(
  process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL,
  TERMS_OF_SERVICE_ENV_VAR,
);

/** Exported for tests — lets them exercise validation without mutating env. */
export const __buildLegalLink = buildLink;
