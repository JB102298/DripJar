/**
 * Token storage — native (iOS/Android) implementation.
 *
 * Backed by expo-secure-store, which stores values in the iOS Keychain and the
 * Android Keystore-backed EncryptedSharedPreferences. This is the pre-existing
 * behaviour and is unchanged: same API calls, same keys, same semantics.
 *
 * Metro resolves this file for `import … from '@/lib/token-storage'` on native
 * and `token-storage.web.ts` on web, so no native module is ever pulled into
 * the web bundle and auth code needs no Platform.OS branching.
 */

import * as SecureStore from 'expo-secure-store';

/** Read a stored value. Returns null when absent. */
export async function getItem(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

/** Write a value. */
export async function setItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

/** Remove a value. Succeeds even when the key is absent. */
export async function deleteItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

/** Identifies the active backend. Useful in diagnostics; never logs values. */
export const storageBackend = 'expo-secure-store' as const;
