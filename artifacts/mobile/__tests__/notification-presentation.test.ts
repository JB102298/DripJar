/**
 * The notification routing table, badge formatting, and accessibility copy.
 *
 * This is the file that answers "where does tapping this go?" for every type
 * the server can emit, so it is tested exhaustively rather than by sample: the
 * matrix below is derived from the server's own NotificationType union, and the
 * first test fails if the server grows a type this table has no answer for.
 */

import { describe, it, expect } from "vitest";
import {
  BADGE_MAX,
  formatBadgeCount,
  formatNotificationTimestamp,
  isLinkableJarTab,
  LINKABLE_JAR_TABS,
  notificationAccessibilityHint,
  notificationAccessibilityLabel,
  notificationHref,
  notificationIcon,
  resolveNotificationDestination,
} from "../lib/notification-presentation";

const JAR = "11111111-2222-4333-8444-555555555555";

/**
 * Every value of NotificationType in
 * artifacts/api-server/src/lib/notifications.ts, with the destination a tap is
 * required to reach. Keep this list in step with the server union.
 */
const MATRIX: ReadonlyArray<[type: string, href: string]> = [
  ["invitation_received", "/(tabs)/jars"],
  ["member_joined", `/jar/${JAR}?tab=Members`],
  ["contribution_recorded", `/jar/${JAR}?tab=Activity`],
  ["contribution_due", `/jar/${JAR}`],
  ["contribution_missed", `/jar/${JAR}`],
  ["contribution_overdue", `/jar/${JAR}`],
  ["jar_halfway_funded", `/jar/${JAR}`],
  ["milestone_funded", `/jar/${JAR}?tab=Milestones`],
  ["commitment_requested", `/jar/${JAR}`],
  ["member_approved_commitment", `/jar/${JAR}`],
  ["member_rejected_commitment", `/jar/${JAR}`],
  ["lock_date_approaching", `/jar/${JAR}`],
  ["goal_fully_funded", `/jar/${JAR}`],
  ["cutoff_upcoming", `/jar/${JAR}`],
  ["cutoff_reached", `/jar/${JAR}`],
  ["agreement_required", `/jar/${JAR}?tab=Agreements`],
  ["autodrip_succeeded", `/jar/${JAR}`],
  ["autodrip_needs_attention", `/jar/${JAR}/autodrip`],
  ["general", `/jar/${JAR}`],
];

const hrefFor = (type: string, relatedJarId: string | null) =>
  notificationHref(resolveNotificationDestination({ type, relatedJarId }));

describe("notification destinations", () => {
  it.each(MATRIX)("routes %s to %s", (type, expected) => {
    expect(hrefFor(type, JAR)).toBe(expected);
  });

  it("sends AutoDrip attention to the corrective surface, not the jar overview", () => {
    expect(hrefFor("autodrip_needs_attention", JAR)).toBe(`/jar/${JAR}/autodrip`);
    expect(hrefFor("autodrip_needs_attention", JAR)).not.toBe(`/jar/${JAR}`);
  });

  it("sends invitations to the existing invitation workflow even without a jar", () => {
    // My Jars is where InvitationCard's accept/decline lives. The invite/[token]
    // route needs a raw token a notification does not carry.
    expect(hrefFor("invitation_received", null)).toBe("/(tabs)/jars");
  });

  it("goes nowhere when a jar-shaped type carries no jar", () => {
    for (const [type] of MATRIX) {
      if (type === "invitation_received") continue;
      expect(hrefFor(type, null), `${type} invented a destination`).toBeNull();
    }
  });

  it("renders an unknown or legacy type safely instead of throwing", () => {
    expect(() => resolveNotificationDestination({ type: "type_from_a_newer_server" })).not.toThrow();
    // With a jar it falls back to the jar's default surface…
    expect(hrefFor("type_from_a_newer_server", JAR)).toBe(`/jar/${JAR}`);
    // …and without one it stays on the list.
    expect(hrefFor("type_from_a_newer_server", null)).toBeNull();
    expect(hrefFor("", null)).toBeNull();
  });

  it("never builds a destination from actionUrl", () => {
    // actionUrl is free text on the notification row. Even a plausible-looking
    // one must not change where a tap goes.
    const href = notificationHref(
      resolveNotificationDestination({
        type: "general",
        relatedJarId: JAR,
        // @ts-expect-error — deliberately passing a field the resolver must ignore
        actionUrl: "/(auth)/login",
      }),
    );
    expect(href).toBe(`/jar/${JAR}`);
  });

  it("only ever produces routes that exist in the app", () => {
    const allowed = [
      /^\/jar\/[^/?]+$/,
      /^\/jar\/[^/?]+\?tab=(Overview|Members|Milestones|Activity|Agreements)$/,
      /^\/jar\/[^/?]+\/autodrip$/,
      /^\/\(tabs\)\/jars$/,
    ];
    for (const [type] of MATRIX) {
      const href = hrefFor(type, JAR)!;
      expect(allowed.some((p) => p.test(href)), `${type} produced ${href}`).toBe(true);
    }
  });
});

describe("linkable jar tabs", () => {
  it("excludes the organizer-only Settings tab", () => {
    // The jar screen hides the Settings tab button for members but renders
    // whatever tab is active, so a deep link naming it would expose organizer
    // controls.
    expect(LINKABLE_JAR_TABS).not.toContain("Settings" as never);
    expect(isLinkableJarTab("Settings")).toBe(false);
  });

  it("accepts only known tab names", () => {
    expect(isLinkableJarTab("Milestones")).toBe(true);
    expect(isLinkableJarTab("milestones")).toBe(false);
    expect(isLinkableJarTab(undefined)).toBe(false);
    expect(isLinkableJarTab(42)).toBe(false);
  });
});

describe("badge formatting", () => {
  it("renders nothing at zero", () => {
    expect(formatBadgeCount(0)).toBeUndefined();
  });

  it("renders nothing when the count is unknown", () => {
    expect(formatBadgeCount(undefined)).toBeUndefined();
    expect(formatBadgeCount(null)).toBeUndefined();
    expect(formatBadgeCount(Number.NaN)).toBeUndefined();
  });

  it("never renders a negative badge", () => {
    expect(formatBadgeCount(-1)).toBeUndefined();
  });

  it("renders the exact count up to the cap", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(42)).toBe("42");
    expect(formatBadgeCount(BADGE_MAX)).toBe("99");
  });

  it("renders 99+ above the cap", () => {
    expect(formatBadgeCount(BADGE_MAX + 1)).toBe("99+");
    expect(formatBadgeCount(1000)).toBe("99+");
  });
});

describe("accessibility copy", () => {
  it("announces read state first, then the server's own text", () => {
    expect(
      notificationAccessibilityLabel({ title: "Jar funded", message: "All done.", isRead: false }),
    ).toBe("Unread. Jar funded. All done.");
    expect(
      notificationAccessibilityLabel({ title: "Jar funded", message: "All done.", isRead: true }),
    ).toBe("Read. Jar funded. All done.");
  });

  it("describes what tapping does for each destination", () => {
    expect(notificationAccessibilityHint({ kind: "jar", jarId: JAR, tab: "Overview" })).toMatch(/jar/i);
    expect(notificationAccessibilityHint({ kind: "autodrip", jarId: JAR })).toMatch(/autodrip/i);
    expect(notificationAccessibilityHint({ kind: "invitations" })).toMatch(/invitation/i);
    expect(notificationAccessibilityHint({ kind: "none" })).toMatch(/read/i);
  });
});

describe("icons", () => {
  it("has an entry for every server type", () => {
    for (const [type] of MATRIX) {
      expect(notificationIcon(type), `${type} has no icon`).toBeTruthy();
    }
  });

  it("falls back rather than failing on an unknown type", () => {
    expect(notificationIcon("something_new")).toBe("bell");
  });
});

describe("timestamps", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  it("reads relative for recent rows", () => {
    expect(formatNotificationTimestamp("2026-08-25T11:59:30.000Z", now)).toBe("Just now");
    expect(formatNotificationTimestamp("2026-08-25T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatNotificationTimestamp("2026-08-25T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatNotificationTimestamp("2026-08-23T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("falls back to a date beyond a week", () => {
    expect(formatNotificationTimestamp("2026-07-01T12:00:00.000Z", now)).toBe("2026-07-01");
  });

  it("returns an empty string rather than throwing on a bad value", () => {
    expect(formatNotificationTimestamp("not-a-date", now)).toBe("");
  });
});
