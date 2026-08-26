/**
 * Notification presentation and navigation — the single place that decides what
 * a notification looks like and where tapping it goes.
 *
 * ─── Why this is centralised ────────────────────────────────────────────────
 *
 * The notification screen used to answer both questions inline: a five-case
 * `switch` for the icon (against nineteen server types) and, for navigation,
 * `if (relatedJarId) push('/jar/' + id)` with an empty `else` branch. Every type
 * that is not jar-shaped — an invitation, an AutoDrip that needs fixing — fell
 * into that empty branch and did nothing at all.
 *
 * ─── What this module may and may not do ────────────────────────────────────
 *
 * It maps a server-supplied `type` and a server-supplied `relatedJarId` onto a
 * route that already exists. That is the whole of its authority.
 *
 *   - It NEVER computes an amount, a percentage, a progress figure, or a
 *     milestone state. Those live in the ledger and arrive pre-rendered in
 *     `title` and `message`; this file does not parse them and must not.
 *   - It NEVER builds a route from `actionUrl`. That column is free text
 *     written by server code (today always `/jar/{id}`, but nothing constrains
 *     it), and following it would let a stored string choose a destination.
 *     Routes are chosen from the type table below and interpolated with the
 *     jar id only.
 *   - It NEVER invents a destination. A type with no safe existing surface
 *     resolves to `{ kind: 'none' }`, and the caller marks the row read and
 *     stays put.
 *
 * An unrecognised type — a legacy row, or one added by a newer server — is not
 * an error. It falls through to the jar surface when it carries a jar, and to
 * `none` when it does not.
 */

/**
 * Tabs on the jar detail screen that are safe to deep-link into.
 *
 * `Settings` is deliberately absent. It is organizer-only, and the jar screen
 * hides its tab button for non-organizers but still renders whatever tab is
 * selected — so a deep link naming it would show organizer controls to a member.
 */
export const LINKABLE_JAR_TABS = [
  'Overview',
  'Members',
  'Milestones',
  'Activity',
  'Agreements',
] as const;

export type LinkableJarTab = (typeof LINKABLE_JAR_TABS)[number];

export function isLinkableJarTab(value: unknown): value is LinkableJarTab {
  return typeof value === 'string' && (LINKABLE_JAR_TABS as readonly string[]).includes(value);
}

/** Where a tapped notification should go. `none` means: stay on the list. */
export type NotificationDestination =
  | { kind: 'jar'; jarId: string; tab: LinkableJarTab }
  | { kind: 'autodrip'; jarId: string }
  | { kind: 'invitations' }
  | { kind: 'none' };

/** The fields this module reads. Deliberately narrower than `Notification`. */
export interface NotificationLike {
  type: string;
  relatedJarId?: string | null;
  isRead?: boolean;
}

/**
 * Per-type routing rule.
 *
 * `jarTab` is the tab to open when the notification carries a jar. `surface`
 * names a non-jar destination that takes precedence when it applies.
 */
type Rule =
  | { surface: 'jar'; jarTab: LinkableJarTab }
  | { surface: 'autodrip' }
  | { surface: 'invitations' };

/**
 * The routing table. Every value in the server's `NotificationType` union has a
 * row here, so a reviewer can read the whole navigation contract in one place.
 */
const RULES: Readonly<Record<string, Rule>> = {
  // Invitations are worked in the existing pending-invitation list on My Jars,
  // which is where InvitationCard (accept / decline) lives. The invite/[token]
  // route needs a raw token the notification does not carry and must not.
  invitation_received: { surface: 'invitations' },

  // AutoDrip's corrective surface. `/jar/{id}/autodrip` is where a paused
  // authorization is resumed and a payment method is replaced.
  autodrip_needs_attention: { surface: 'autodrip' },
  autodrip_succeeded: { surface: 'jar', jarTab: 'Overview' },

  member_joined: { surface: 'jar', jarTab: 'Members' },
  milestone_funded: { surface: 'jar', jarTab: 'Milestones' },
  agreement_required: { surface: 'jar', jarTab: 'Agreements' },

  jar_halfway_funded: { surface: 'jar', jarTab: 'Overview' },
  goal_fully_funded: { surface: 'jar', jarTab: 'Overview' },

  contribution_recorded: { surface: 'jar', jarTab: 'Activity' },
  contribution_due: { surface: 'jar', jarTab: 'Overview' },
  contribution_missed: { surface: 'jar', jarTab: 'Overview' },
  contribution_overdue: { surface: 'jar', jarTab: 'Overview' },

  commitment_requested: { surface: 'jar', jarTab: 'Overview' },
  member_approved_commitment: { surface: 'jar', jarTab: 'Overview' },
  member_rejected_commitment: { surface: 'jar', jarTab: 'Overview' },

  lock_date_approaching: { surface: 'jar', jarTab: 'Overview' },
  cutoff_upcoming: { surface: 'jar', jarTab: 'Overview' },
  cutoff_reached: { surface: 'jar', jarTab: 'Overview' },

  general: { surface: 'jar', jarTab: 'Overview' },
};

/**
 * Resolve a notification to a destination.
 *
 * Every jar-bearing surface requires a jar id. A row whose `relatedJarId` is
 * null cannot address a jar, so it resolves to `none` rather than to a route
 * with an empty segment.
 */
export function resolveNotificationDestination(n: NotificationLike): NotificationDestination {
  const rule = RULES[n.type];

  if (rule?.surface === 'invitations') return { kind: 'invitations' };

  const jarId = n.relatedJarId ?? null;
  if (!jarId) return { kind: 'none' };

  if (rule?.surface === 'autodrip') return { kind: 'autodrip', jarId };

  // Known jar rule, or an unrecognised type that nonetheless names a jar: the
  // jar's default surface is always a safe answer.
  return { kind: 'jar', jarId, tab: rule?.surface === 'jar' ? rule.jarTab : 'Overview' };
}

/**
 * The router path for a destination, or null when there is nowhere to go.
 *
 * Paths are built here and nowhere else, so the set of routes a notification
 * can reach is enumerable by reading this function.
 */
export function notificationHref(destination: NotificationDestination): string | null {
  switch (destination.kind) {
    case 'jar':
      return destination.tab === 'Overview'
        ? `/jar/${destination.jarId}`
        : `/jar/${destination.jarId}?tab=${destination.tab}`;
    case 'autodrip':
      return `/jar/${destination.jarId}/autodrip`;
    case 'invitations':
      return '/(tabs)/jars';
    case 'none':
      return null;
  }
}

// ─── Icons ───────────────────────────────────────────────────────────────────

/**
 * Feather glyph per type. Presentation only — no icon here encodes a financial
 * fact, and a missing entry falls back to the bell rather than throwing.
 */
const ICONS: Readonly<Record<string, string>> = {
  invitation_received: 'mail',
  member_joined: 'user-plus',

  contribution_recorded: 'dollar-sign',
  contribution_due: 'clock',
  contribution_missed: 'alert-circle',
  contribution_overdue: 'alert-circle',

  jar_halfway_funded: 'trending-up',
  milestone_funded: 'flag',
  goal_fully_funded: 'check-circle',

  commitment_requested: 'help-circle',
  member_approved_commitment: 'thumbs-up',
  member_rejected_commitment: 'thumbs-down',

  lock_date_approaching: 'calendar',
  cutoff_upcoming: 'calendar',
  cutoff_reached: 'lock',

  agreement_required: 'file-text',

  autodrip_succeeded: 'check-circle',
  autodrip_needs_attention: 'alert-triangle',

  general: 'bell',
};

export function notificationIcon(type: string): string {
  return ICONS[type] ?? 'bell';
}

// ─── Badge ───────────────────────────────────────────────────────────────────

/**
 * The tab-bar badge label.
 *
 * Returns undefined at zero so the badge is not rendered at all — a badge
 * showing "0" is still a badge, and a freshly reset owner must see none.
 *
 * `99+` above 99: the app had no prior convention (the badge previously
 * rendered a raw number that could not exceed the page cap anyway), so the
 * platform-standard cap is adopted rather than letting a four-digit count
 * stretch the tab bar.
 */
export const BADGE_MAX = 99;

export function formatBadgeCount(unreadCount: number | undefined | null): string | undefined {
  if (typeof unreadCount !== 'number' || !Number.isFinite(unreadCount) || unreadCount <= 0) {
    return undefined;
  }
  const whole = Math.floor(unreadCount);
  if (whole <= 0) return undefined;
  return whole > BADGE_MAX ? `${BADGE_MAX}+` : String(whole);
}

// ─── Accessibility ───────────────────────────────────────────────────────────

/**
 * The label a screen reader announces for a row.
 *
 * Read state leads, because it is the thing a sighted user gets from the "New"
 * pill and the heavier title and a screen-reader user would otherwise not get
 * at all. Title and message are the server's own text, verbatim.
 */
export function notificationAccessibilityLabel(n: {
  title: string;
  message: string;
  isRead: boolean;
}): string {
  return `${n.isRead ? 'Read' : 'Unread'}. ${n.title}. ${n.message}`;
}

/** The hint describing what tapping does, given where the row leads. */
export function notificationAccessibilityHint(destination: NotificationDestination): string {
  switch (destination.kind) {
    case 'jar':
      return 'Opens the jar';
    case 'autodrip':
      return 'Opens AutoDrip settings for this jar';
    case 'invitations':
      return 'Opens your invitations';
    case 'none':
      return 'Marks this notification as read';
  }
}

// ─── Timestamps ──────────────────────────────────────────────────────────────

/**
 * A short relative age for a notification.
 *
 * Relative rather than a formatted date because the list is read newest-first
 * and "2h ago" answers the question a date does not. Falls back to an ISO date
 * beyond a week, and to an empty string for an unparseable value — a bad
 * timestamp must not take the row down.
 */
export function formatNotificationTimestamp(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return '';

  const seconds = Math.floor((now.getTime() - ms) / 1000);
  if (seconds < 60) return 'Just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return then.toISOString().slice(0, 10);
}
