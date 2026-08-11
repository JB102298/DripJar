/**
 * Token storage — web implementation.
 *
 * expo-secure-store is native-only: on web its methods are undefined, which is
 * what produced `ExpoSecureStore.default.setValueWithKeyAsync is not a function`
 * at login. There is no browser equivalent of the iOS Keychain, so this adapter
 * uses `localStorage` and matches the native persistence contract: tokens
 * survive a page refresh and a browser restart, exactly as they survive an app
 * restart on device.
 *
 * SECURITY NOTE — this is a genuine difference in protection level, not an
 * oversight. `localStorage` is readable by any JavaScript running on the origin,
 * so a successful XSS on the web build can exfiltrate tokens; Keychain/Keystore
 * on native are not reachable that way. The trade-off is accepted here because:
 *   - the API is Bearer-token based, so the access token is already held in JS
 *     memory and attached to requests by the client regardless of where it rests;
 *   - access tokens are short-lived (15 minutes) and refresh tokens rotate on
 *     every use, limiting the value of a stolen pair;
 *   - the alternative — an httpOnly cookie — would require server-side session
 *     changes, which is a change to auth semantics rather than a storage fix.
 * If the web build later becomes a primary surface, revisit this with httpOnly
 * refresh cookies plus in-memory-only access tokens.
 *
 * Values are never logged.
 */

/**
 * In-memory fallback for environments where localStorage is unavailable or
 * throws: Safari private mode, disabled site data, SSR/prerender passes. Auth
 * then works for the lifetime of the page instead of crashing at login; the
 * session simply does not survive a refresh.
 */
const memoryFallback = new Map<string, string>();

let warnedUnavailable = false;

function getLocalStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined') return null;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Access a property to surface SecurityError in restricted contexts before
    // we rely on it (some browsers expose the object but throw on use).
    void ls.length;
    return ls;
  } catch {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      // Message only — never include the key or value.
      console.warn(
        '[token-storage] localStorage unavailable; falling back to in-memory storage. ' +
        'The session will not persist across page reloads.',
      );
    }
    return null;
  }
}

/** Read a stored value. Returns null when absent. */
export async function getItem(key: string): Promise<string | null> {
  const ls = getLocalStorage();
  if (!ls) return memoryFallback.get(key) ?? null;
  try {
    return ls.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

/** Write a value. */
export async function setItem(key: string, value: string): Promise<void> {
  const ls = getLocalStorage();
  if (!ls) {
    memoryFallback.set(key, value);
    return;
  }
  try {
    ls.setItem(key, value);
  } catch {
    // Quota exceeded or storage blocked mid-session — keep the session alive.
    memoryFallback.set(key, value);
  }
}

/**
 * Remove a value. Succeeds even when the key is absent.
 *
 * Clears both backends unconditionally so a logout cannot leave a token behind
 * in the fallback map if storage availability changed during the session.
 */
export async function deleteItem(key: string): Promise<void> {
  memoryFallback.delete(key);
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(key);
  } catch {
    // Already unreachable; the in-memory copy is gone, which is what matters.
  }
}

/** Identifies the active backend. Useful in diagnostics; never logs values. */
export const storageBackend = 'localStorage' as const;

/** Exported for tests — lets them assert fallback behaviour deterministically. */
export const __memoryFallback = memoryFallback;
