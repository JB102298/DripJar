import { Resend } from "resend";
import { logger } from "./logger.js";

let resend: Resend | null = null;

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

function getResendClient(): Resend | null {
  // Never send real emails from the test suite (registration now triggers a
  // verification email, and tests register many throwaway accounts).
  if (process.env["NODE_ENV"] === "test") return null;
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    logger.warn("RESEND_API_KEY is not set — email delivery is disabled");
    return null;
  }
  if (!resend) {
    resend = new Resend(apiKey);
  }
  return resend;
}

export function getAppBaseUrl(): string {
  // In Replit dev the mobile app is served at the dev domain root
  const domain = process.env["REPLIT_DEV_DOMAIN"];
  if (domain) return `https://${domain}`;
  // Allow explicit override for production
  return process.env["APP_BASE_URL"] ?? "https://m3jar.com";
}

export function getFromAddress(): string {
  return process.env["EMAIL_FROM"] ?? "M3Jar <noreply@updates.m3jar.com>";
}

export function buildPasswordResetUrl(rawToken: string): string {
  return `${getAppBaseUrl()}/reset-password/${rawToken}`;
}

export function buildEmailVerificationUrl(rawToken: string): string {
  return `${getAppBaseUrl()}/verify-email/${rawToken}`;
}

export async function sendInvitationEmail(opts: {
  toEmail: string;
  jarName: string;
  inviterName: string;
  token: string;
}): Promise<void> {
  const client = getResendClient();
  if (!client) {
    if (isProduction()) {
      // Never log raw tokens in production
      logger.error(
        { toEmail: opts.toEmail },
        "Email delivery skipped (no RESEND_API_KEY) — invitation email NOT sent",
      );
    } else {
      logger.info(
        { toEmail: opts.toEmail, token: opts.token },
        "Email delivery skipped (no RESEND_API_KEY) — invitation token logged for manual testing (dev only)",
      );
    }
    return;
  }

  const inviteUrl = `${getAppBaseUrl()}/invite/${opts.token}`;
  const fromAddress = getFromAddress();

  try {
    const { error } = await client.emails.send({
      from: fromAddress,
      to: opts.toEmail,
      subject: `${opts.inviterName} invited you to join "${opts.jarName}" on M3Jar`,
      text: `You're invited!

${opts.inviterName} has invited you to join their savings jar "${opts.jarName}" on M3Jar — the easiest way to save for meaningful moments together.

Accept the invitation: ${inviteUrl}

This link expires in 7 days. If you didn't expect this, you can safely ignore it.`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#178B57;padding:32px;text-align:center;">
              <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 M3Jar</p>
              <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Travel Savings</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">You're invited!</h1>
              <p style="margin:0 0 24px;font-size:16px;color:#6B7280;line-height:1.6;">
                <strong style="color:#111827;">${opts.inviterName}</strong> has invited you to join their savings jar
                <strong style="color:#111827;">"${opts.jarName}"</strong> on M3Jar — the easiest way to save for meaningful moments together.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${inviteUrl}"
                   style="display:inline-block;background:#178B57;color:#ffffff;font-size:17px;font-weight:bold;
                          text-decoration:none;padding:16px 40px;border-radius:12px;">
                  Accept Invitation
                </a>
              </div>
              <p style="margin:0;font-size:14px;color:#9CA3AF;text-align:center;">
                This link expires in 7 days. If you didn't expect this, you can safely ignore it.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                Or copy this link: <a href="${inviteUrl}" style="color:#178B57;">${inviteUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    if (error) {
      logger.error({ error, toEmail: opts.toEmail }, "Resend API error sending invitation email");
    } else {
      logger.info({ toEmail: opts.toEmail }, "Invitation email sent successfully");
    }
  } catch (err) {
    logger.error({ err, toEmail: opts.toEmail }, "Failed to send invitation email");
  }
}

/**
 * Send an email-verification email containing the raw verification token
 * embedded ONLY in the verification URL delivered to the intended recipient.
 *
 * Never throws — delivery failures are logged operationally (without the raw
 * token in production) so callers can always return their generic response.
 */
export async function sendVerificationEmail(opts: {
  toEmail: string;
  token: string;
}): Promise<void> {
  const client = getResendClient();
  if (!client) {
    if (isProduction()) {
      // Never log raw tokens in production
      logger.error(
        { toEmail: opts.toEmail },
        "Email delivery skipped (no RESEND_API_KEY) — verification email NOT sent",
      );
    } else {
      logger.info(
        { toEmail: opts.toEmail, token: opts.token },
        "Email delivery skipped (no RESEND_API_KEY) — verification token logged for manual testing (dev only)",
      );
    }
    return;
  }

  const verifyUrl = buildEmailVerificationUrl(opts.token);
  const fromAddress = getFromAddress();

  try {
    const { error } = await client.emails.send({
      from: fromAddress,
      to: opts.toEmail,
      subject: "Verify your M3Jar email address",
      text: `Verify your M3Jar email address

Thanks for joining M3Jar! Please confirm this email address so we know it's really you:

${verifyUrl}

This link expires in 24 hours and can only be used once.

If you didn't create an M3Jar account, you can safely ignore this email.`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#178B57;padding:32px;text-align:center;">
              <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 M3Jar</p>
              <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Travel Savings</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">Verify your email</h1>
              <p style="margin:0 0 24px;font-size:16px;color:#6B7280;line-height:1.6;">
                Thanks for joining M3Jar! Please confirm this email address so we know it's really you.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}"
                   style="display:inline-block;background:#178B57;color:#ffffff;font-size:17px;font-weight:bold;
                          text-decoration:none;padding:16px 40px;border-radius:12px;">
                  Verify Email
                </a>
              </div>
              <p style="margin:0;font-size:14px;color:#9CA3AF;text-align:center;">
                This link expires in 24 hours and can only be used once.<br />
                If you didn't create an M3Jar account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                Or copy this link: <a href="${verifyUrl}" style="color:#178B57;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    if (error) {
      logger.error({ error, toEmail: opts.toEmail }, "Resend API error sending verification email");
    } else {
      logger.info({ toEmail: opts.toEmail }, "Verification email sent successfully");
    }
  } catch (err) {
    logger.error({ err, toEmail: opts.toEmail }, "Failed to send verification email");
  }
}

/**
 * Send a password-reset email containing the raw reset token embedded ONLY in
 * the reset URL delivered to the intended recipient.
 *
 * Never throws — delivery failures are logged operationally (without the raw
 * token) so the calling route can always return its generic anti-enumeration
 * response.
 */
export async function sendPasswordResetEmail(opts: {
  toEmail: string;
  token: string;
}): Promise<void> {
  const client = getResendClient();
  if (!client) {
    if (isProduction()) {
      // Never log raw tokens in production
      logger.error(
        { toEmail: opts.toEmail },
        "Email delivery skipped (no RESEND_API_KEY) — password reset email NOT sent",
      );
    } else {
      logger.info(
        { toEmail: opts.toEmail, token: opts.token },
        "Email delivery skipped (no RESEND_API_KEY) — reset token logged for manual testing (dev only)",
      );
    }
    return;
  }

  const resetUrl = buildPasswordResetUrl(opts.token);
  const fromAddress = getFromAddress();

  try {
    const { error } = await client.emails.send({
      from: fromAddress,
      to: opts.toEmail,
      subject: "Reset your M3Jar password",
      text: `Reset your M3Jar password

We received a request to reset the password for your M3Jar account. If you made this request, open the link below to choose a new password:

${resetUrl}

This link expires in 1 hour and can only be used once.

If you didn't request a password reset, you can safely ignore this email — your password has not been changed.`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#178B57;padding:32px;text-align:center;">
              <p style="margin:0;color:#ffffff;font-size:28px;font-weight:bold;">🫙 M3Jar</p>
              <p style="margin:8px 0 0;color:#E8F6EF;font-size:15px;">Group Travel Savings</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="margin:0 0 16px;font-size:24px;color:#111827;font-weight:bold;">Reset your password</h1>
              <p style="margin:0 0 24px;font-size:16px;color:#6B7280;line-height:1.6;">
                We received a request to reset the password for your M3Jar account.
                If you made this request, click the button below to choose a new password.
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
                If you didn't request a password reset, you can safely ignore this email —
                your password has not been changed.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #E5E7EB;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                Or copy this link: <a href="${resetUrl}" style="color:#178B57;">${resetUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    if (error) {
      logger.error(
        { error, toEmail: opts.toEmail },
        "Resend API error sending password reset email",
      );
    } else {
      logger.info({ toEmail: opts.toEmail }, "Password reset email sent successfully");
    }
  } catch (err) {
    logger.error({ err, toEmail: opts.toEmail }, "Failed to send password reset email");
  }
}
