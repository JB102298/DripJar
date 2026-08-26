/**
 * The app's single QueryClient.
 *
 * It was previously constructed inline in `app/_layout.tsx`, which meant the
 * only way to reach it was `useQueryClient()` — a hook, and therefore usable
 * only from inside the provider subtree. `auth-context` needs to clear the
 * cache on every identity change (see the comment there), and making that
 * depend on provider placement would have coupled a security property to a
 * component tree. Exporting the instance keeps one cache for the process and
 * lets non-render code reach it directly.
 *
 * `refetchOnWindowFocus` is React Query's default and is left on. On web it
 * fires from real window focus events; on native it fires from the AppState
 * bridge installed in `app/_layout.tsx`, which is what makes "refresh when the
 * app comes back to the foreground" true on a device rather than only in a
 * browser.
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient();
