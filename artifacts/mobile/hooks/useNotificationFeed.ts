/**
 * The notification feed: the paged list, the exact unread total, and the two
 * read mutations, with one consistent cache story between them.
 *
 * ─── Why the count is not derived from the list ─────────────────────────────
 *
 * The badge previously read `list.filter(n => !n.isRead).length`. The list is a
 * page, so that number was the unread count *of the rows that happened to be
 * loaded* — capped at the page size, and 0 whenever the first page was fully
 * read regardless of what lay behind it. `GET /notifications/unread-count`
 * returns the caller's true total, and this hook treats it as the only source
 * for the badge. Loading more pages therefore cannot change the badge, which is
 * the correctness property the old code got backwards.
 *
 * ─── Optimistic reads ───────────────────────────────────────────────────────
 *
 * A tap must feel instant, so the row and the badge are updated before the
 * request resolves. Both are snapshotted first and restored together if it
 * fails, and both are invalidated on settle so the server reconciles whatever
 * the optimistic guess got wrong. In-flight queries are cancelled first —
 * without that, a refetch already on the wire can land after the optimistic
 * write and resurrect the stale row.
 *
 * The decrement is conditional on the row currently being unread in the cache.
 * That is what makes repeated taps safe: the second tap finds `isRead: true`
 * and leaves the count alone, so a double tap cannot drive the badge below the
 * server's number.
 */

import { useCallback, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  getGetUnreadNotificationCountQueryKey,
  getUnreadNotificationCount,
  type Notification,
  type UnreadNotificationCount,
} from '@workspace/api-client-react';

/** Server default is 50 and its cap is 100; 25 is a screenful with room to page. */
export const NOTIFICATION_PAGE_SIZE = 25;

/**
 * Distinct from `getListNotificationsQueryKey()` on purpose. That key belongs to
 * the generated single-page hook; this feed stores `InfiniteData` under its own
 * key so the two shapes can never be written into the same cache entry.
 */
export const NOTIFICATION_FEED_KEY = ['/api/notifications', 'feed'] as const;

/**
 * Hoisted to module scope because `getGetUnreadNotificationCountQueryKey()`
 * allocates a fresh array per call. Reading it inside the component would give
 * every `useCallback` below a new dependency each render, and `refresh` has to
 * be referentially stable — the screen passes it to `useFocusEffect`, which
 * re-runs its effect whenever the callback identity changes.
 */
export const UNREAD_COUNT_KEY = getGetUnreadNotificationCountQueryKey();

type Feed = InfiniteData<Notification[], number>;

// ─── Pure cache transforms (exported for direct testing) ─────────────────────

/** Mark exactly one row read. Every other row is returned untouched. */
export function feedWithRowRead(feed: Feed | undefined, notificationId: string): Feed | undefined {
  if (!feed) return feed;
  return {
    ...feed,
    pages: feed.pages.map((page) =>
      page.map((n) => (n.id === notificationId ? { ...n, isRead: true } : n)),
    ),
  };
}

/** Mark every loaded row read. Rows on unloaded pages are the server's job. */
export function feedWithAllRead(feed: Feed | undefined): Feed | undefined {
  if (!feed) return feed;
  return {
    ...feed,
    pages: feed.pages.map((page) => page.map((n) => (n.isRead ? n : { ...n, isRead: true }))),
  };
}

/** Is this row currently unread in the cache? Drives the conditional decrement. */
export function isRowUnread(feed: Feed | undefined, notificationId: string): boolean {
  if (!feed) return false;
  for (const page of feed.pages) {
    for (const n of page) {
      if (n.id === notificationId) return !n.isRead;
    }
  }
  return false;
}

/** Never below zero: an optimistic guess must not produce an impossible badge. */
export function decremented(count: UnreadNotificationCount | undefined): UnreadNotificationCount {
  return { unreadCount: Math.max(0, (count?.unreadCount ?? 0) - 1) };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface NotificationFeed {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  isError: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  refresh: () => Promise<void>;
  markRead: (notificationId: string) => void;
  markAllRead: () => void;
  isMarkingAllRead: boolean;
}

export function useNotificationFeed(enabled = true): NotificationFeed {
  const queryClient = useQueryClient();
  const countKey = UNREAD_COUNT_KEY;

  /**
   * Ids with a mark-read request in flight.
   *
   * The cache guard in `markRead` is not sufficient on its own: `onMutate` is
   * async — it awaits `cancelQueries` before writing the optimistic value — so
   * two taps dispatched in the same tick both read the row as still unread and
   * both fire. The count survives that (only the first `onMutate` observes
   * `wasUnread`), but the extra requests are real. A synchronous set closes the
   * window that the cache cannot.
   */
  const inFlightReads = useRef<Set<string>>(new Set());

  const feedQuery = useInfiniteQuery<Notification[], Error, Feed, readonly unknown[], number>({
    queryKey: NOTIFICATION_FEED_KEY,
    queryFn: ({ pageParam, signal }) =>
      listNotifications({ limit: NOTIFICATION_PAGE_SIZE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    // A short page means the server has no more rows. Offset paging is safe here
    // because the server orders by (createdAt, id) — a total order.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < NOTIFICATION_PAGE_SIZE ? undefined : allPages.length * NOTIFICATION_PAGE_SIZE,
    enabled,
  });

  const countQuery = useQuery({
    queryKey: countKey,
    queryFn: ({ signal }) => getUnreadNotificationCount({ signal }),
    enabled,
  });

  const invalidateBoth = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_FEED_KEY });
    void queryClient.invalidateQueries({ queryKey: countKey });
  }, [queryClient, countKey]);

  const markReadMutation = useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onMutate: async (notificationId: string) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATION_FEED_KEY });
      await queryClient.cancelQueries({ queryKey: countKey });

      const previousFeed = queryClient.getQueryData<Feed>(NOTIFICATION_FEED_KEY);
      const previousCount = queryClient.getQueryData<UnreadNotificationCount>(countKey);
      const wasUnread = isRowUnread(previousFeed, notificationId);

      queryClient.setQueryData<Feed>(NOTIFICATION_FEED_KEY, (f) => feedWithRowRead(f, notificationId));
      if (wasUnread) {
        queryClient.setQueryData<UnreadNotificationCount>(countKey, (c) => decremented(c));
      }

      return { previousFeed, previousCount };
    },
    onError: (_err, _id, context) => {
      // Restore both together. Rolling back one and not the other would leave a
      // badge that disagrees with the rows the user is looking at.
      if (context?.previousFeed !== undefined) {
        queryClient.setQueryData(NOTIFICATION_FEED_KEY, context.previousFeed);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(countKey, context.previousCount);
      }
    },
    onSettled: (_data, _err, notificationId) => {
      inFlightReads.current.delete(notificationId);
      invalidateBoth();
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATION_FEED_KEY });
      await queryClient.cancelQueries({ queryKey: countKey });

      const previousFeed = queryClient.getQueryData<Feed>(NOTIFICATION_FEED_KEY);
      const previousCount = queryClient.getQueryData<UnreadNotificationCount>(countKey);

      queryClient.setQueryData<Feed>(NOTIFICATION_FEED_KEY, (f) => feedWithAllRead(f));
      queryClient.setQueryData<UnreadNotificationCount>(countKey, { unreadCount: 0 });

      return { previousFeed, previousCount };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousFeed !== undefined) {
        queryClient.setQueryData(NOTIFICATION_FEED_KEY, context.previousFeed);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(countKey, context.previousCount);
      }
    },
    onSettled: invalidateBoth,
  });

  const notifications = feedQuery.data?.pages.flat() ?? [];

  // Driven through the query client rather than the query objects so the
  // callback identity is stable across renders (see UNREAD_COUNT_KEY).
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: NOTIFICATION_FEED_KEY }),
      queryClient.refetchQueries({ queryKey: countKey }),
    ]);
  }, [queryClient, countKey]);

  // `mutate` is referentially stable in React Query v5; the mutation object is
  // not, so only the function is taken as a dependency.
  const mutateMarkRead = markReadMutation.mutate;
  const markRead = useCallback(
    (notificationId: string) => {
      // Already read, or already being read: no request, no count change. This
      // is what makes a second tap a no-op rather than a redundant round trip.
      if (inFlightReads.current.has(notificationId)) return;
      const feed = queryClient.getQueryData<Feed>(NOTIFICATION_FEED_KEY);
      if (!isRowUnread(feed, notificationId)) return;

      inFlightReads.current.add(notificationId);
      mutateMarkRead(notificationId);
    },
    [queryClient, mutateMarkRead],
  );

  return {
    notifications,
    unreadCount: countQuery.data?.unreadCount ?? 0,
    isLoading: feedQuery.isLoading,
    // A failed list must not be presented as an empty one. The screen renders a
    // distinct error state off this flag.
    isError: feedQuery.isError,
    isRefreshing: feedQuery.isRefetching && !feedQuery.isFetchingNextPage,
    hasMore: Boolean(feedQuery.hasNextPage),
    isLoadingMore: feedQuery.isFetchingNextPage,
    loadMore: () => {
      if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) void feedQuery.fetchNextPage();
    },
    refresh,
    markRead,
    markAllRead: () => markAllReadMutation.mutate(),
    isMarkingAllRead: markAllReadMutation.isPending,
  };
}
