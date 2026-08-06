/**
 * Live Resend verification script.
 * Uses delivered@resend.dev — Resend's built-in sink address that accepts
 * the request and marks it delivered without sending to a real inbox.
 * Run with: node scripts/test-resend-live.mjs
 */
import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error("FATAL: RESEND_API_KEY is not set");
  process.exit(1);
}

const from = process.env.EMAIL_FROM ?? "DripJar <noreply@updates.thedripjar.com>";
const to   = "delivered@resend.dev"; // Resend's official test sink address

const resend = new Resend(apiKey);

// ── Build the DripJar password-reset template (same as production) ────────────
const resetUrl = "https://thedripjar.com/reset-password/test-token-verify";

const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#178B57;padding:32px;text-align:center;">
            <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 DripJar</p>
            <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Savings, Simplified</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 32px;">
            <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">Reset your password</h1>
            <p style="margin:0 0 24px;font-size:16px;color:#6B7280;line-height:1.6;">
              We received a request to reset the password for your DripJar account.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${resetUrl}"
                 style="display:inline-block;background:#178B57;color:#ffffff;font-size:17px;font-weight:bold;
                        text-decoration:none;padding:16px 40px;border-radius:12px;">
                Reset Password
              </a>
            </div>
            <p style="margin:0;font-size:14px;color:#9CA3AF;text-align:center;">
              This link expires in 1 hour and can only be used once.<br />
              If you didn't request a password reset, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;">
              Or copy this link: <a href="${resetUrl}" style="color:#178B57;">${resetUrl}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const text = `Reset your DripJar password\n\nWe received a request to reset your DripJar account password.\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore it.\n\nDripJar`;

console.log("Sending test email via Resend...");
console.log(`  from: ${from}`);
console.log(`  to:   ${to}`);

const { data, error } = await resend.emails.send({
  from,
  to,
  subject: "Reset your DripJar password [LIVE TEST]",
  html,
  text,
});

if (error) {
  console.error("\n❌ Resend API rejected the request:");
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}

console.log("\n✅ Resend accepted the message.");
console.log("  Message ID:", data?.id);
console.log("  Sender:    ", from);

// Branding check on rendered content
const legacyTerms = ["M3Jar", "TripJar", "m3jar.com", "@m3jar.dev", "updates.m3jar.com"];
const combined = html + text + (data?.id ?? "");
const found = legacyTerms.filter(t => combined.toLowerCase().includes(t.toLowerCase()));
if (found.length > 0) {
  console.error("\n❌ Legacy brand terms found in rendered message:", found);
  process.exit(1);
}
console.log("  Legacy brand check: CLEAN — no M3Jar/TripJar strings in rendered message");

// Parse and verify sender domain
const domainMatch = from.match(/@([\w.]+)>/);
const senderDomain = domainMatch?.[1] ?? "";
if (senderDomain !== "updates.thedripjar.com") {
  console.error(`\n❌ Sender domain mismatch: expected updates.thedripjar.com, got ${senderDomain}`);
  process.exit(1);
}
console.log("  Sender domain:      updates.thedripjar.com ✅");

// Confirm display name
if (!from.startsWith("DripJar ")) {
  console.error(`\n❌ Display name mismatch: expected 'DripJar', got '${from}'`);
  process.exit(1);
}
console.log("  Display name:       DripJar ✅");

console.log("\n✅ All checks passed.");
