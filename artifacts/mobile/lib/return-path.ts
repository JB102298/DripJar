/**
 * Sanitize a `returnTo` navigation parameter.
 *
 * Only in-app absolute paths are allowed (e.g. "/invite/abc123"). Anything
 * else — external URLs, protocol-relative URLs ("//evil.com"), schemes,
 * missing values — is rejected and the caller should fall back to the
 * default destination.
 */
export function sanitizeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('://') || value.includes('\\')) return null;
  return value;
}
