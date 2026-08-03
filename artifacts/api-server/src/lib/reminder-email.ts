/**
 * Reminder email functions for Phase 3 automation.
 *
 * RETURN VALUE SEMANTICS — every function returns Promise<boolean>:
 *   true  = email delivered (or test-mode vacuous success — no real email)
 *   false = delivery failed; caller should record 'failed' status for retry
 *
 * ENVIRONMENT BEHAVIOUR:
 *
 *   NODE_ENV = 'test'
 *     → getResendClient() returns { client: null, vacuousSuccess: true }
 *     → All email functions return true immediately (no network call)
 *     → Recipients are NEVER contacted; TEST_EMAIL_RECIPIENT is not consulted
 *       (recipient always comes from profile data, server-side only)
 *
 *   NODE_ENV ≠ 'test', RESEND_API_KEY missing
 *     → getResendClient() returns { client: null, vacuousSuccess: false }
 *     → All email functions return false immediately
 *     → The reminder_sent_events row stays/becomes 'failed'
 *     → Once the key is configured, the next processor run retries delivery
 *     → This is NOT treated as success — missing key is a configuration failure
 *
 *   NODE_ENV ≠ 'test', RESEND_API_KEY present
 *     → getResendClient() returns { client: Resend, vacuousSuccess: false }
 *     → Functions call client.emails.send(); catch any exception → return false
 *     → Resend send failure → false → row becomes/stays 'failed' → retried
 *
 * HTML TEMPLATE:
 *   Full M3Jar transactional layout — white card, #178B57 green header,
 *   CTA button, footer with manage-preferences link. Plain-text fallback
 *   always included.
 */
import { Resend } from "resend";
import { logger } from "./logger.js";
import { getAppBaseUrl, getFromAddress } from "./email.js";

// ─── Client factory ──────────────────────────────────────────────────────────

interface ResendClientResult {
  client: Resend;
  vacuousSuccess: false;
}
interface NoClientResult {
  client: null;
  /** true = test mode (report success without sending); false = config failure (report failure) */
  vacuousSuccess: boolean;
}
type ClientResult = ResendClientResult | NoClientResult;

function getResendClient(): ClientResult {
  // Test mode: suppress all real delivery; report vacuous success so the state
  // machine can be exercised in tests without actual network traffic.
  if (process.env["NODE_ENV"] === "test") {
    return { client: null, vacuousSuccess: true };
  }

  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    // Production/development: missing key is a CONFIGURATION FAILURE, not success.
    // The reminder row remains 'failed' and is automatically retried once the key
    // is set. Do NOT return vacuousSuccess=true here — that would permanently
    // silently swallow emails in misconfigured production deployments.
    logger.warn(
      { env: process.env["NODE_ENV"] },
      "RESEND_API_KEY not set — email delivery disabled; reminder row will be retried once key is configured",
    );
    return { client: null, vacuousSuccess: false };
  }

  return { client: new Resend(apiKey), vacuousSuccess: false };
}

// ─── HTML template builder ───────────────────────────────────────────────────

function buildHtml(opts: {
  headingText: string;
  bodyHtml: string;
  ctaUrl?: string;
  ctaLabel?: string;
  noteHtml?: string;
  baseUrl: string;
}): string {
  const cta = opts.ctaUrl && opts.ctaLabel
    ? `<div style="text-align:center;margin:32px 0;">
        <a href="${opts.ctaUrl}"
           style="display:inline-block;background:#178B57;color:#ffffff;font-size:17px;font-weight:bold;
                  text-decoration:none;padding:16px 40px;border-radius:12px;">
          ${opts.ctaLabel}
        </a>
      </div>`
    : "";
  const note = opts.noteHtml
    ? `<p style="margin:16px 0 0;font-size:14px;color:#9CA3AF;text-align:center;">${opts.noteHtml}</p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#178B57;padding:32px;text-align:center;">
              <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 M3Jar</p>
              <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Travel Savings</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">${opts.headingText}</h1>
              ${opts.bodyHtml}
              ${cta}
              ${note}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                M3Jar &middot;
                <a href="${opts.baseUrl}/profile" style="color:#178B57;">Manage email preferences</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function jarUrl(jarId: string): string {
  return `${getAppBaseUrl()}/jar/${jarId}`;
}

// ─── Contribution Due ─────────────────────────────────────────────────────────

export async function sendContributionDueEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  amountCents: number;
  dueDateISO: string;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, amountCents, dueDateISO } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;
  try {
    const base = getAppBaseUrl();
    const link = jarUrl(jarId);
    const amount = fmt(amountCents);
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `Your ${amount} contribution to ${jarName} is due`,
      html: buildHtml({
        headingText: "Contribution Due",
        bodyHtml: `<p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Hi <strong style="color:#111827;">${displayName}</strong>,
        </p>
        <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Your <strong style="color:#111827;">${amount}</strong> contribution to
          <strong style="color:#111827;">${jarName}</strong> is due on
          <strong style="color:#111827;">${dueDateISO}</strong>.
          Keep your savings on track by making your contribution today.
        </p>`,
        ctaUrl: link,
        ctaLabel: "View Your Jar",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nYour ${amount} contribution to ${jarName} is due on ${dueDateISO}.\n\nKeep your savings on track — view your jar:\n${link}\n\nM3Jar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, toEmail, type: "contribution_due" }, "Reminder email delivery failed");
    return false;
  }
}

// ─── Contribution Missed ──────────────────────────────────────────────────────

export async function sendContributionMissedEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  amountCents: number;
  outstandingCents: number;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, outstandingCents } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;
  try {
    const base = getAppBaseUrl();
    const link = jarUrl(jarId);
    const outstanding = fmt(outstandingCents);
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `Missed contribution to ${jarName} — ${outstanding} outstanding`,
      html: buildHtml({
        headingText: "Contribution Outstanding",
        bodyHtml: `<p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Hi <strong style="color:#111827;">${displayName}</strong>,
        </p>
        <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Your scheduled contribution to <strong style="color:#111827;">${jarName}</strong> has a
          cumulative outstanding balance of <strong style="color:#C0392B;">${outstanding}</strong>.
          Adding a contribution now will bring you back on track.
        </p>`,
        ctaUrl: link,
        ctaLabel: "Add a Contribution",
        noteHtml: "Note: M3Jar is currently in simulated mode. No real money is transferred.",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nYour scheduled contribution to ${jarName} has an outstanding balance of ${outstanding}.\n\nAdd a contribution: ${link}\n\nNote: M3Jar is currently in simulated mode.\n\nM3Jar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, toEmail, type: "contribution_missed" }, "Reminder email delivery failed");
    return false;
  }
}

// ─── Cutoff Upcoming ──────────────────────────────────────────────────────────

export async function sendCutoffUpcomingEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  cutoffDateISO: string;
  daysAway: number;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, cutoffDateISO, daysAway } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;
  try {
    const base = getAppBaseUrl();
    const link = jarUrl(jarId);
    const dayWord = daysAway === 1 ? "1 day" : `${daysAway} days`;
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `${jarName} commitment date in ${dayWord}`,
      html: buildHtml({
        headingText: `Commitment Date in ${dayWord}`,
        bodyHtml: `<p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Hi <strong style="color:#111827;">${displayName}</strong>,
        </p>
        <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          The commitment date for <strong style="color:#111827;">${jarName}</strong> is in
          <strong style="color:#111827;">${dayWord}</strong> (${cutoffDateISO}).
        </p>
        <p style="margin:0 0 0;font-size:16px;color:#6B7280;line-height:1.6;">
          After this date the jar enters the <strong style="color:#111827;">Commitment phase</strong> —
          schedules can no longer be changed. Make sure your savings agreement is accepted and your
          contributions are up to date.
        </p>`,
        ctaUrl: link,
        ctaLabel: "View Your Jar",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nThe commitment date for ${jarName} is in ${dayWord} (${cutoffDateISO}).\n\nAfter this date the jar enters the Commitment phase — schedules can no longer be changed.\n\nView your jar: ${link}\n\nM3Jar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, toEmail, type: "cutoff_upcoming" }, "Reminder email delivery failed");
    return false;
  }
}

// ─── Cutoff Reached ───────────────────────────────────────────────────────────

export async function sendCutoffReachedEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  cutoffDateISO: string;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, cutoffDateISO } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;
  try {
    const base = getAppBaseUrl();
    const link = jarUrl(jarId);
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `${jarName} has entered the Commitment phase`,
      html: buildHtml({
        headingText: "Commitment Phase Reached",
        bodyHtml: `<p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Hi <strong style="color:#111827;">${displayName}</strong>,
        </p>
        <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          <strong style="color:#111827;">${jarName}</strong> reached its commitment date on
          <strong style="color:#111827;">${cutoffDateISO}</strong> and is now in the
          <strong style="color:#111827;">Commitment phase</strong>.
        </p>
        <p style="margin:0 0 0;font-size:16px;color:#6B7280;line-height:1.6;">
          Contribution schedules are now locked. Contributions remain open —
          review your current status and make sure you&rsquo;re on track.
        </p>`,
        ctaUrl: link,
        ctaLabel: "Open Your Jar",
        noteHtml: "M3Jar is currently in simulated mode. No real money is held or transferred.",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\n${jarName} reached its commitment date on ${cutoffDateISO} and is now in the Commitment phase.\n\nSchedules are locked; contributions remain open.\n\nOpen your jar: ${link}\n\nM3Jar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, toEmail, type: "cutoff_reached" }, "Reminder email delivery failed");
    return false;
  }
}

// ─── Agreement Required ───────────────────────────────────────────────────────

export async function sendAgreementRequiredEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  version: string;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, version } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;
  try {
    const base = getAppBaseUrl();
    const link = jarUrl(jarId);
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `Action needed: accept the savings agreement for ${jarName}`,
      html: buildHtml({
        headingText: "Savings Agreement Needs Acceptance",
        bodyHtml: `<p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          Hi <strong style="color:#111827;">${displayName}</strong>,
        </p>
        <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
          The savings agreement for <strong style="color:#111827;">${jarName}</strong>
          (version <strong style="color:#111827;">${version}</strong>) requires your acceptance
          before you can make contributions or update your schedule.
        </p>
        <p style="margin:0 0 0;font-size:16px;color:#6B7280;line-height:1.6;">
          The jar&rsquo;s phase is determined by the commitment date — not by agreement status.
          Accepting the agreement now ensures you can continue participating.
        </p>`,
        ctaUrl: link,
        ctaLabel: "Review & Accept",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nThe savings agreement for ${jarName} (v${version}) requires your acceptance before you can make contributions or update your schedule.\n\nNote: the jar's phase is determined by the commitment date — not by whether you've accepted.\n\nReview and accept: ${link}\n\nM3Jar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, toEmail, type: "agreement_required" }, "Reminder email delivery failed");
    return false;
  }
}
