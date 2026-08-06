/**
 * AutoDrip email notifications — Phase 4E
 *
 * Reuses the DripJar transactional email layout from reminder-email.ts.
 * Two email types:
 *   1. AutoDrip succeeded — brief confirmation after webhook posts
 *   2. AutoDrip needs attention — prompt to fix payment and explicitly resume
 *
 * Follows the same vacuous-success pattern as reminder-email.ts:
 *   test mode   → return true (no network call)
 *   missing key → return false (will be retried)
 *   live        → call Resend, return true/false
 */

import { Resend } from "resend";
import { logger } from "./logger.js";
import { getAppBaseUrl, getFromAddress } from "./email.js";

function getResendClient(): { client: Resend | null; vacuousSuccess: boolean } {
  if (process.env["NODE_ENV"] === "test") return { client: null, vacuousSuccess: true };
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set — autodrip email suppressed");
    return { client: null, vacuousSuccess: false };
  }
  return { client: new Resend(apiKey), vacuousSuccess: false };
}

function buildHtml(opts: {
  headingText: string;
  bodyHtml: string;
  ctaUrl?: string;
  ctaLabel?: string;
  baseUrl: string;
}): string {
  const cta =
    opts.ctaUrl && opts.ctaLabel
      ? `<div style="text-align:center;margin:32px 0;">
          <a href="${opts.ctaUrl}" style="display:inline-block;background:#178B57;color:#ffffff;font-size:17px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:12px;">${opts.ctaLabel}</a>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#178B57;padding:32px;text-align:center;">
  <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 DripJar</p>
  <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Savings, Simplified</p>
</td></tr>
<tr><td style="padding:40px 32px;">
  <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">${opts.headingText}</h1>
  ${opts.bodyHtml}
  ${cta}
</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
  <p style="margin:0;font-size:12px;color:#9CA3AF;">DripJar &middot;
    <a href="${opts.baseUrl}/profile" style="color:#178B57;">Manage email preferences</a>
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── AutoDrip Succeeded ───────────────────────────────────────────────────────

export async function sendAutoDripSucceededEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  principalCents: number;
  frequency: string;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, principalCents, frequency } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;

  try {
    const base = getAppBaseUrl();
    const amount = fmt(principalCents);
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `Your ${amount} AutoDrip to ${jarName} was processed`,
      html: buildHtml({
        headingText: "AutoDrip Processed ✓",
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">Hi <strong style="color:#111827;">${displayName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
            Your automatic <strong style="color:#111827;">${amount}</strong> Drip to
            <strong style="color:#111827;">${jarName}</strong> has been successfully processed.
          </p>
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
            Your AutoDrip continues on its <strong style="color:#111827;">${frequency}</strong> schedule.
          </p>`,
        ctaUrl: `${base}/jar/${jarId}`,
        ctaLabel: "View Jar",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nYour ${amount} AutoDrip to ${jarName} has been successfully processed.\n\nYour AutoDrip continues on its ${frequency} schedule.\n\nView your jar: ${base}/jar/${jarId}\n\n— DripJar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, "AutoDrip succeeded email failed");
    return false;
  }
}

// ─── AutoDrip Needs Attention ──────────────────────────────────────────────────

export async function sendAutoDripNeedsAttentionEmail(opts: {
  toEmail: string;
  displayName: string;
  jarName: string;
  jarId: string;
  reason: string;
}): Promise<boolean> {
  const { toEmail, displayName, jarName, jarId, reason } = opts;
  const { client, vacuousSuccess } = getResendClient();
  if (!client) return vacuousSuccess;

  try {
    const base = getAppBaseUrl();
    await client.emails.send({
      from: getFromAddress(),
      to: toEmail,
      subject: `Action required: Your AutoDrip to ${jarName} needs attention`,
      html: buildHtml({
        headingText: "AutoDrip Needs Attention",
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">Hi <strong style="color:#111827;">${displayName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
            Your AutoDrip to <strong style="color:#111827;">${jarName}</strong> encountered a problem
            and has been paused.
          </p>
          <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;margin:0 0 16px;">
            <p style="margin:0;font-size:14px;color:#B91C1C;">${reason}</p>
          </div>
          <p style="margin:0 0 16px;font-size:16px;color:#6B7280;line-height:1.6;">
            To resume AutoDrip, open the DripJar app, go to your jar, and use the
            <strong style="color:#111827;">Resume AutoDrip</strong> button after resolving the payment issue.
            Future automatic Drips remain blocked until you explicitly resume.
          </p>`,
        ctaUrl: `${base}/jar/${jarId}`,
        ctaLabel: "Fix Payment & Resume",
        baseUrl: base,
      }),
      text: `Hi ${displayName},\n\nYour AutoDrip to ${jarName} encountered a problem and has been paused.\n\nReason: ${reason}\n\nTo resume, open the DripJar app and use the "Resume AutoDrip" button after resolving the payment issue.\n\nView your jar: ${base}/jar/${jarId}\n\n— DripJar`,
    });
    return true;
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, "AutoDrip needs-attention email failed");
    return false;
  }
}
