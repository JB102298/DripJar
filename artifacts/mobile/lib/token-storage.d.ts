/**
 * Token storage — shared contract for the platform-specific pair.
 *
 * Metro resolves `token-storage.native.ts` on iOS/Android and
 * `token-storage.web.ts` on web. `tsc` does not apply React Native platform
 * extensions, so this declaration types the extensionless import used by auth
 * code. Both implementations are still fully type-checked on their own — they
 * are matched by the tsconfig `**\/*.ts` include.
 *
 * Every method is async so the native (Keychain/Keystore) and web
 * (localStorage) backends share one interface and auth code needs no
 * Platform.OS branching.
 */

/** Read a stored value. Resolves to null when the key is absent. */
export declare function getItem(key: string): Promise<string | null>;

/** Write a value. */
export declare function setItem(key: string, value: string): Promise<void>;

/** Remove a value. Resolves successfully even when the key is absent. */
export declare function deleteItem(key: string): Promise<void>;

/** Identifies the active backend. Diagnostics only; never carries a value. */
export declare const storageBackend: 'expo-secure-store' | 'localStorage';
