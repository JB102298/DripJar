/**
 * Stripe Webhook Handler — Phase 4B
 *
 * POST /webhooks/stripe
 *
 * Authentication: Stripe signature verification — NO JWT auth.
 * The Stripe-Signature header is the sole authentication mechanism.
 * Stripe's signature verifies the payload was sent by Stripe and has not
 * been tampered with.
 *
 * Raw body: req.body is a Buffer (set by express.raw in app.ts).
 * stripe.webhooks.constructEvent() receives the raw Buffer — never a
 * parsed/re-stringified string.
 *
 * Idempotency: stripeEventId unique index prevents double-processing.
 * Concurrent delivery: the unique constraint on stripeEventId ensures
 * exactly one row per event; duplicate inserts fail gracefully.
 *
 * Handled events:
 *   payment_intent.succeeded         → post ledger entries, mark succeeded
 *   payment_intent.payment_failed    → mark failed
 *   payment_intent.canceled          → mark cancelled
 *   (all others)                     → mark ignored, return 200
 *
 * Security:
 *   - Raw payload contents are NEVER logged
 *   - STRIPE_WEBHOOK_SECRET is NEVER logged
 *   - providerTransactionId cross-checked from DB, not from event metadata
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  financialTransactions,
  contributions,
  stripeWebhookEvents,
  refundAllocations,
  refundRequests,
  autoDripRuns,
  autoDripAuthorizations,
  jars,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getStripeClient } from "../lib/stripe.js";
import {
  postContributionAccounting,
  clearLedgerAccountCache,
  postRefundFinalizationInTx,
  postRefundReversalInTx,
} from "../lib/ledger.js";
import { mapStripeRefundStatus, recomputeRefundRequestStatus, TERMINAL_ALLOCATION_STATES } from "../lib/refund-helpers.js";
import { notifyAutoDripSucceeded } from "./autodrip.js";
import { notifyContributionSettled } from "../lib/notification-financial.js";
import { emitNotificationOnce, notificationEventKey } from "../lib/notification-events.js";
import { logger } from "../lib/logger.js";
import type Stripe from "stripe";

// Suppress unused import warning — clearLedgerAccountCache imported for tests
void clearLedgerAccountCache;

const router = Router();

// ─── POST /webhooks/stripe ────────────────────────────────────────────────────

router.post("/webhooks/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  if (!sig || typeof sig !== "string") {
    res.status(400).json({ error: "BadRequest", message: "Missing Stripe-Signature header" });
    return;
  }

  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    logger.error("STRIPE_WEBHOOK_SECRET is not configured");
    res.status(500).json({ error: "InternalError", message: "Webhook not configured" });
    return;
  }

  // req.body is a Buffer set by express.raw — exact byte sequence preserved
  const rawBody = req.body as Buffer;

  let event: Stripe.Event;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    // Invalid signature — log safe info only (no payload contents)
    logger.warn({ err: { message: (err as Error).message } }, "Stripe webhook signature verification failed");
    res.status(400).json({ error: "BadRequest", message: "Invalid Stripe signature" });
    return;
  }

  // Idempotency: check if this event has already been processed
  const [existingEvent] = await db
    .select({
      id: stripeWebhookEvents.id,
      processingStatus: stripeWebhookEvents.processingStatus,
    })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.stripeEventId, event.id));

  if (existingEvent?.processingStatus === "processed") {
    // Already successfully processed — tell Stripe to stop retrying
    res.status(200).json({ received: true, status: "already_processed" });
    return;
  }

  // Insert or update the event row (upsert via unique constraint)
  let eventRowId: string;
  if (existingEvent) {
    eventRowId = existingEvent.id;
    await db
      .update(stripeWebhookEvents)
      .set({ attemptCount: sql`${stripeWebhookEvents.attemptCount} + 1` })
      .where(eq(stripeWebhookEvents.id, existingEvent.id));
  } else {
    const [inserted] = await db
      .insert(stripeWebhookEvents)
      .values({
        stripeEventId: event.id,
        eventType: event.type,
        stripeCreatedAt: new Date(event.created * 1000),
        processingStatus: "received",
        attemptCount: 1,
      })
      .onConflictDoNothing()
      .returning({ id: stripeWebhookEvents.id });
    if (!inserted) {
      // Race: concurrent worker inserted first (onConflictDoNothing returns nothing) — re-read
      const [raceRow] = await db
        .select({ id: stripeWebhookEvents.id, processingStatus: stripeWebhookEvents.processingStatus })
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event.id));
      if (raceRow?.processingStatus === "processed") {
        res.status(200).json({ received: true, status: "already_processed" });
        return;
      }
      eventRowId = raceRow?.id ?? "";
    } else {
      eventRowId = inserted.id;
    }
  }

  // Dispatch to event handler
  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event, eventRowId);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event, eventRowId);
        break;
      case "payment_intent.canceled":
        await handlePaymentIntentCanceled(event, eventRowId);
        break;
      case "refund.updated":
        await handleRefundUpdated(event, eventRowId);
        break;
      case "refund.failed":
        await handleRefundFailed(event, eventRowId);
        break;
      default:
        // Unknown event type — acknowledge and ignore
        await db
          .update(stripeWebhookEvents)
          .set({ processingStatus: "ignored", processedAt: new Date() })
          .where(eq(stripeWebhookEvents.id, eventRowId));
        res.status(200).json({ received: true, status: "ignored" });
        return;
    }
  } catch (err) {
    // Handler threw — mark event failed so Stripe will retry
    logger.error(
      { err: { message: (err as Error).message, name: (err as Error).name }, eventType: event.type },
      "Stripe webhook handler error",
    );
    try {
      await db
        .update(stripeWebhookEvents)
        .set({
          processingStatus: "failed",
          errorMessage: (err as Error).message,
        })
        .where(eq(stripeWebhookEvents.id, eventRowId));
    } catch {
      // DB update itself failed — nothing more we can do
    }
    // Re-throw → Express global error handler → 500 → Stripe retries
    throw err;
  }

  res.status(200).json({ received: true });
});

// ─── payment_intent.succeeded ─────────────────────────────────────────────────

async function handlePaymentIntentSucceeded(
  event: Stripe.Event,
  eventRowId: string,
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;

  // Route AutoDrip PIs through separate handler
  if (pi.metadata?.["source"] === "autodrip") {
    await handleAutoDripSucceeded(pi, eventRowId);
    return;
  }

  // Find financial_transaction by providerTransactionId (DB-stored, not metadata)
  // Metadata is a routing hint only; the cross-check below is the authorization.
  const [ft] = await db
    .select({
      id: financialTransactions.id,
      jarId: financialTransactions.jarId,
      memberId: financialTransactions.memberId,
      totalQuotedCents: financialTransactions.totalQuotedCents,
      currency: financialTransactions.currency,
      providerTransactionId: financialTransactions.providerTransactionId,
      providerStatus: financialTransactions.providerStatus,
      ledgerPostingStatus: financialTransactions.ledgerPostingStatus,
      requestedPrincipalCents: financialTransactions.requestedPrincipalCents,
      processingFeeEstimatedCents: financialTransactions.processingFeeEstimatedCents,
    })
    .from(financialTransactions)
    .where(eq(financialTransactions.providerTransactionId, pi.id));

  if (!ft) {
    // Unknown PI — not for this system; mark ignored
    await db
      .update(stripeWebhookEvents)
      .set({
        processingStatus: "ignored",
        errorMessage: `No financial_transaction found for PaymentIntent ${pi.id}`,
        processedAt: new Date(),
      })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Cross-check: amount, currency, and PI ID must all match DB record
  const amountMatch = ft.totalQuotedCents === pi.amount;
  const currencyMatch = ft.currency.toLowerCase() === pi.currency.toLowerCase();
  const piIdMatch = ft.providerTransactionId === pi.id;

  if (!amountMatch || !currencyMatch || !piIdMatch) {
    logger.error(
      {
        financialTransactionId: ft.id,
        dbAmount: ft.totalQuotedCents,
        stripeAmount: pi.amount,
        dbCurrency: ft.currency,
        stripeCurrency: pi.currency,
        piIdMatch,
      },
      "Stripe webhook: PaymentIntent mismatch — no ledger posting",
    );
    await db
      .update(stripeWebhookEvents)
      .set({
        processingStatus: "failed",
        financialTransactionId: ft.id,
        errorMessage: "PaymentIntent amount/currency/ID mismatch — manual review required",
        processedAt: new Date(),
      })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    // Return 200 to prevent infinite retry — this is a permanent mismatch
    return;
  }

  // Mark event as processing and link to financial transaction
  await db
    .update(stripeWebhookEvents)
    .set({
      processingStatus: "processing",
      financialTransactionId: ft.id,
    })
    .where(eq(stripeWebhookEvents.id, eventRowId));

  // Guard: if already posted, this is a duplicate delivery — acknowledge
  if (ft.ledgerPostingStatus === "posted") {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Post ledger accounting + update financial_transaction + insert contribution
  // All in a single atomic DB transaction
  type DbOrTx = typeof db;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as DbOrTx;

    // Re-check ledgerPostingStatus inside the transaction (double-guard)
    const [locked] = await txDb
      .select({ ledgerPostingStatus: financialTransactions.ledgerPostingStatus })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, ft.id))
      .for("update");

    if (locked?.ledgerPostingStatus === "posted") {
      // Concurrent delivery already won the lock.
      // Mark this event processed too so no late "processing" update can win.
      await txDb
        .update(stripeWebhookEvents)
        .set({ processingStatus: "processed", processedAt: new Date() })
        .where(eq(stripeWebhookEvents.id, eventRowId));
      return;
    }

    // Post the contribution accounting
    const { ledgerTransactionId } = await postContributionAccounting({
      jarId: ft.jarId,
      memberId: ft.memberId,
      principalCents: Number(ft.requestedPrincipalCents),
      estimatedProcessingFeeCents: Number(ft.processingFeeEstimatedCents),
      currency: ft.currency,
      idempotencyKey: `stripe-webhook:${pi.id}`,
    });

    // Update financial_transaction status
    await txDb
      .update(financialTransactions)
      .set({
        providerStatus: "succeeded",
        ledgerPostingStatus: "posted",
        ledgerId: ledgerTransactionId,
        updatedAt: new Date(),
      })
      .where(eq(financialTransactions.id, ft.id));

    // Insert contributions row
    const today = new Date().toISOString().slice(0, 10);
    await txDb.insert(contributions).values({
      jarId: ft.jarId,
      memberId: ft.memberId,
      amountCents: Number(ft.requestedPrincipalCents),
      contributionDate: today,
      status: "stripe_test",
      sourceType: "stripe_test",
      externalPaymentId: pi.id,
    });

    // Mark webhook event as processed
    await txDb
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
  });

  // Canonical financial notifications — contribution, then any progress
  // threshold or milestone the settlement completed.
  //
  // Deliberately AFTER the transaction commits, and deliberately awaited.
  //
  // After: a notification failure must never roll back a ledger posting, and
  // the notification layer must read the committed row, not the uncommitted
  // one. Awaited: the handler marks the Stripe event 'processed' inside the
  // transaction above, so an un-awaited emission could still be running when
  // the process exits after responding.
  //
  // Called unconditionally rather than only on the branch that did the
  // posting. Every emission is keyed on the financial transaction id, so a
  // delivery that lost the FOR UPDATE race re-derives the same keys and
  // creates nothing — while a delivery that WON the race but crashed before
  // notifying is recovered by the next redelivery. Gating on "did I post?"
  // would give up that recovery for no benefit.
  await notifyContributionSettled(ft.id);

  // Attempt to reconcile actual Stripe fee (best-effort; null on failure)
  void reconcileActualFee(ft.id, pi).catch((err: unknown) => {
    logger.warn(
      { err: { message: (err as Error).message }, financialTransactionId: ft.id },
      "Stripe fee reconciliation failed (non-fatal)",
    );
  });
}

// ─── AutoDrip succeeded handler ───────────────────────────────────────────────

async function handleAutoDripSucceeded(
  pi: Stripe.PaymentIntent,
  eventRowId: string,
): Promise<void> {
  // Find the AutoDrip run by PI ID (set by processor after PI creation)
  const [run] = await db
    .select()
    .from(autoDripRuns)
    .where(eq(autoDripRuns.stripePaymentIntentId, pi.id));

  if (!run) {
    await db
      .update(stripeWebhookEvents)
      .set({
        processingStatus: "ignored",
        errorMessage: `No autodrip_run found for PaymentIntent ${pi.id}`,
        processedAt: new Date(),
      })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Idempotency: if already succeeded, acknowledge.
  //
  // Still runs the notification path before returning. The run is already
  // settled, so nothing financial can change; what this recovers is the
  // window where a previous delivery committed the ledger posting and then
  // died before notifying. Without this the early return would make the
  // AutoDrip path at-most-once while the card path is exactly-once, for no
  // reason other than where the guard sits. Every emission is keyed, so the
  // ordinary case — a redelivery of an already-notified run — writes nothing.
  if (run.status === "succeeded") {
    if (run.financialTransactionId) {
      await notifyContributionSettled(run.financialTransactionId);
    }
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Load authorization
  const [auth] = await db
    .select()
    .from(autoDripAuthorizations)
    .where(eq(autoDripAuthorizations.id, run.autoDripAuthorizationId));

  if (!auth) {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "ignored", errorMessage: "AutoDrip authorization not found", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  const now = new Date();
  type DbOrTx = typeof db;

  // Set by whichever delivery actually posts. Read after the transaction so
  // the notification layer can be pointed at the canonical FT.
  let postedFinancialTransactionId: string | null = null;

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as DbOrTx;

    // Lock run row (prevent concurrent duplicate processing)
    const [lockedRun] = await txDb
      .select({ status: autoDripRuns.status })
      .from(autoDripRuns)
      .where(eq(autoDripRuns.id, run.id))
      .for("update");

    if (lockedRun?.status === "succeeded") {
      await txDb
        .update(stripeWebhookEvents)
        .set({ processingStatus: "processed", processedAt: now })
        .where(eq(stripeWebhookEvents.id, eventRowId));
      return;
    }

    // Post contribution accounting (creates FT + ledger entries + updates FT to posted)
    const idempotencyKey = `autodrip-webhook:${run.id}:${pi.id}`;
    const { financialTransactionId } = await postContributionAccounting({
      jarId: auth.jarId,
      memberId: auth.memberId,
      principalCents: run.principalCents,
      currency: "USD",
      idempotencyKey,
      transactionType: "autodrip_contribution",
      providerType: "stripe",
      providerTransactionId: pi.id,
      providerStatus: "succeeded",
    });

    postedFinancialTransactionId = financialTransactionId;

    // Insert contribution row
    const today = now.toISOString().slice(0, 10);
    await txDb.insert(contributions).values({
      jarId: auth.jarId,
      memberId: auth.memberId,
      amountCents: run.principalCents,
      contributionDate: today,
      status: "stripe_test",
      sourceType: "stripe_test_autodrip",
      externalPaymentId: pi.id,
    });

    // Mark run succeeded
    await txDb
      .update(autoDripRuns)
      .set({
        status: "succeeded",
        financialTransactionId,
        completedAt: now,
      })
      .where(eq(autoDripRuns.id, run.id));

    // Advance authorization last_run_at — do NOT change status (spec: success webhook
    // does NOT clear needs_attention; only explicit /resume does)
    await txDb
      .update(autoDripAuthorizations)
      .set({ lastRunAt: now, updatedAt: now })
      .where(eq(autoDripAuthorizations.id, auth.id));

    // Mark webhook event processed
    await txDb
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: now })
      .where(eq(stripeWebhookEvents.id, eventRowId));
  });

  // ─── Notifications ────────────────────────────────────────────────────────
  //
  // This block used to run unconditionally, including when the FOR UPDATE
  // guard above found the run already 'succeeded' and returned without doing
  // anything. Twenty concurrent deliveries of one AutoDrip success therefore
  // produced twenty "AutoDrip Processed" notifications and twenty emails.
  //
  // Two independent fixes, because they protect against different failures:
  //
  //   postedFinancialTransactionId  suppresses the losing concurrent delivery
  //                                 before it reaches the email path, which
  //                                 has no event identity of its own.
  //   emitNotificationOnce          makes the in-app notification exactly-once
  //                                 durably, so a redelivery arriving minutes
  //                                 later — a different process, with its own
  //                                 empty locals — also creates nothing.
  const settledFtId = postedFinancialTransactionId as string | null;
  if (settledFtId !== null) {
    // AutoDrip principal is jar principal like any other. The contributor and
    // the other active members hear about it through the same canonical path
    // as a card drip, including any threshold or milestone it completes.
    await notifyContributionSettled(settledFtId);

    // Plus the AutoDrip-specific confirmation, to the authorizing member only.
    const [jarRow] = await db
      .select({ name: jars.name })
      .from(jars)
      .where(eq(jars.id, auth.jarId))
      .limit(1);

    if (jarRow) {
      await emitNotificationOnce({
        eventKey: notificationEventKey.autoDripSucceeded(run.id),
        eventType: "autodrip_succeeded",
        userId: auth.userId,
        jarId: auth.jarId,
        type: "autodrip_succeeded",
        title: "AutoDrip Processed",
        message: `Your automatic Drip to ${jarRow.name} was processed successfully.`,
      });
    }

    // Email channel, unchanged in content and now guarded by the same
    // condition. Left fire-and-forget: it is a separate channel and must not
    // delay the webhook response.
    void notifyAutoDripSucceeded({
      userId: auth.userId,
      jarId: auth.jarId,
      principalCents: run.principalCents,
      frequency: auth.frequency,
    });
  }
}

// ─── AutoDrip failed handler ──────────────────────────────────────────────────

async function handleAutoDripFailed(
  pi: Stripe.PaymentIntent,
  eventRowId: string,
): Promise<void> {
  const [run] = await db
    .select()
    .from(autoDripRuns)
    .where(eq(autoDripRuns.stripePaymentIntentId, pi.id));

  if (!run) {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "ignored", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Idempotency guard
  if (run.status === "failed" || run.status === "action_required") {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  const [auth] = await db
    .select()
    .from(autoDripAuthorizations)
    .where(eq(autoDripAuthorizations.id, run.autoDripAuthorizationId));

  const now = new Date();
  const failureCode = pi.last_payment_error?.code ?? "payment_failed";
  const failureMessage = pi.last_payment_error?.message ?? "Payment failed";

  await db
    .update(autoDripRuns)
    .set({ status: "failed", failureCode, failureMessage, completedAt: now })
    .where(eq(autoDripRuns.id, run.id));

  if (auth && auth.status !== "needs_attention" && auth.status !== "cancelled" && auth.status !== "completed") {
    await db
      .update(autoDripAuthorizations)
      .set({ status: "needs_attention", needsAttentionAt: now, needsAttentionReason: failureMessage, updatedAt: now })
      .where(eq(autoDripAuthorizations.id, auth.id));

    // Notify (best-effort)
    //
    // Keyed on the RUN, not the authorization. A redelivery of this run's
    // failure is one event; a later run failing is a new event the member must
    // see. The message stays generic on purpose — `failureMessage` is a raw
    // Stripe `last_payment_error.message` and must not reach a customer.
    if (auth) {
      void (async () => {
        try {
          const { users, jars: jarsTable, profiles } = await import("@workspace/db");
          const [userRow] = await db.select({ email: users.email }).from(users).where(eq(users.id, auth.userId));
          const [profileRow] = await db.select({ displayName: profiles.displayName }).from(profiles).where(eq(profiles.userId, auth.userId));
          const [jarRow] = await db.select({ name: jarsTable.name }).from(jarsTable).where(eq(jarsTable.id, auth.jarId));
          if (userRow && jarRow) {
            const { sendAutoDripNeedsAttentionEmail } = await import("../lib/autodrip-email.js");
            void sendAutoDripNeedsAttentionEmail({ toEmail: userRow.email, displayName: profileRow?.displayName ?? userRow.email, jarName: jarRow.name, jarId: auth.jarId, reason: failureMessage });
            await emitNotificationOnce({
              eventKey: notificationEventKey.autoDripNeedsAttention(run.id),
              eventType: "autodrip_needs_attention",
              userId: auth.userId,
              jarId: auth.jarId,
              type: "autodrip_needs_attention",
              title: "AutoDrip Needs Attention",
              message: `Your AutoDrip to ${jarRow.name} could not be processed. Tap to fix.`,
            });
          }
        } catch (err) { logger.warn({ err: { message: (err as Error).message } }, "Failed to send autodrip failure notification"); }
      })();
    }
  }

  await db
    .update(stripeWebhookEvents)
    .set({ processingStatus: "processed", processedAt: now })
    .where(eq(stripeWebhookEvents.id, eventRowId));
}

// ─── payment_intent.payment_failed ────────────────────────────────────────────

async function handlePaymentIntentFailed(
  event: Stripe.Event,
  eventRowId: string,
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;

  // Route AutoDrip PIs through dedicated handler
  if (pi.metadata?.["source"] === "autodrip") {
    await handleAutoDripFailed(pi, eventRowId);
    return;
  }

  const [ft] = await db
    .select({ id: financialTransactions.id })
    .from(financialTransactions)
    .where(eq(financialTransactions.providerTransactionId, pi.id));

  if (!ft) {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "ignored", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  await db
    .update(financialTransactions)
    .set({ providerStatus: "failed", updatedAt: new Date() })
    .where(eq(financialTransactions.id, ft.id));

  await db
    .update(stripeWebhookEvents)
    .set({
      processingStatus: "processed",
      financialTransactionId: ft.id,
      processedAt: new Date(),
    })
    .where(eq(stripeWebhookEvents.id, eventRowId));
}

// ─── payment_intent.canceled ──────────────────────────────────────────────────

async function handlePaymentIntentCanceled(
  event: Stripe.Event,
  eventRowId: string,
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;

  const [ft] = await db
    .select({ id: financialTransactions.id })
    .from(financialTransactions)
    .where(eq(financialTransactions.providerTransactionId, pi.id));

  if (!ft) {
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "ignored", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  await db
    .update(financialTransactions)
    .set({ providerStatus: "cancelled", updatedAt: new Date() })
    .where(eq(financialTransactions.id, ft.id));

  await db
    .update(stripeWebhookEvents)
    .set({
      processingStatus: "processed",
      financialTransactionId: ft.id,
      processedAt: new Date(),
    })
    .where(eq(stripeWebhookEvents.id, eventRowId));
}

// ─── refund.updated ───────────────────────────────────────────────────────────

async function handleRefundUpdated(
  event: Stripe.Event,
  eventRowId: string,
): Promise<void> {
  const stripeRefund = event.data.object as Stripe.Refund;
  type DbOrTx = typeof db;

  // Map Stripe status to internal domain status
  const internalStatus = mapStripeRefundStatus(stripeRefund.status ?? "pending");

  if (internalStatus === null) {
    // Unknown Stripe status — log and acknowledge safely without state mutation
    logger.warn(
      { stripeRefundId: stripeRefund.id, stripeStatus: stripeRefund.status, eventId: event.id },
      "Stripe webhook: unknown refund status — no state change applied",
    );
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "ignored", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Find refund_allocation by stripe_refund_id
  const [alloc] = await db
    .select()
    .from(refundAllocations)
    .where(eq(refundAllocations.stripeRefundId, stripeRefund.id))
    .limit(1);

  if (!alloc) {
    // Not our refund or not yet dispatched — mark ignored
    await db
      .update(stripeWebhookEvents)
      .set({
        processingStatus: "ignored",
        errorMessage: `No refund_allocation found for Stripe refund ${stripeRefund.id}`,
        processedAt: new Date(),
      })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Guard: terminal states cannot regress
  if (TERMINAL_ALLOCATION_STATES.has(alloc.providerStatus)) {
    // Already at a terminal state — idempotent duplicate delivery
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Load the parent refund_request to get member/jar context for ledger posting
  const [rr] = await db
    .select()
    .from(refundRequests)
    .where(eq(refundRequests.id, alloc.refundRequestId))
    .limit(1);

  if (!rr) {
    logger.error({ allocationId: alloc.id }, "Stripe webhook: refund_request not found for allocation");
    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "failed", errorMessage: "refund_request not found", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
    return;
  }

  // Mark event processing
  await db
    .update(stripeWebhookEvents)
    .set({ processingStatus: "processing" })
    .where(eq(stripeWebhookEvents.id, eventRowId));

  // Handle by status
  if (internalStatus === "succeeded") {
    // Finalization: REFUND_PENDING DR / REFUND_CLR CR
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DbOrTx;

      // Guard inside tx: check terminal state again under lock (concurrent delivery)
      const [lockedAlloc] = await txDb
        .select({ providerStatus: refundAllocations.providerStatus, finalizationFtId: refundAllocations.finalizationFtId })
        .from(refundAllocations)
        .where(eq(refundAllocations.id, alloc.id))
        .for("update");

      if (lockedAlloc && TERMINAL_ALLOCATION_STATES.has(lockedAlloc.providerStatus)) {
        // Race: already finalized by concurrent delivery
        await txDb
          .update(stripeWebhookEvents)
          .set({ processingStatus: "processed", processedAt: new Date() })
          .where(eq(stripeWebhookEvents.id, eventRowId));
        return;
      }

      const { financialTransactionId } = await postRefundFinalizationInTx(txDb, {
        jarId: rr.jarId,
        memberId: rr.memberId,
        amountCents: Number(alloc.allocatedCents),
        idempotencyKey: `refund-finalize:${alloc.id}`,
      });

      await txDb
        .update(refundAllocations)
        .set({
          providerStatus: "succeeded",
          finalizationFtId: financialTransactionId,
          updatedAt: new Date(),
        })
        .where(eq(refundAllocations.id, alloc.id));

      const aggregateStatus = await recomputeRefundRequestStatus(rr.id, txDb);
      await txDb
        .update(refundRequests)
        .set({ status: aggregateStatus, updatedAt: new Date() })
        .where(eq(refundRequests.id, rr.id));

      await txDb
        .update(stripeWebhookEvents)
        .set({ processingStatus: "processed", processedAt: new Date() })
        .where(eq(stripeWebhookEvents.id, eventRowId));
    });
  } else if (internalStatus === "failed" || internalStatus === "cancelled") {
    // Reversal: REFUND_PENDING DR / CTRB_REFUNDABLE CR
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DbOrTx;

      const [lockedAlloc] = await txDb
        .select({ providerStatus: refundAllocations.providerStatus })
        .from(refundAllocations)
        .where(eq(refundAllocations.id, alloc.id))
        .for("update");

      if (lockedAlloc && TERMINAL_ALLOCATION_STATES.has(lockedAlloc.providerStatus)) {
        await txDb
          .update(stripeWebhookEvents)
          .set({ processingStatus: "processed", processedAt: new Date() })
          .where(eq(stripeWebhookEvents.id, eventRowId));
        return;
      }

      const { financialTransactionId } = await postRefundReversalInTx(txDb, {
        jarId: rr.jarId,
        memberId: rr.memberId,
        amountCents: Number(alloc.allocatedCents),
        idempotencyKey: `refund-reversal:${alloc.id}`,
      });

      await txDb
        .update(refundAllocations)
        .set({
          providerStatus: internalStatus,
          finalizationFtId: financialTransactionId,
          updatedAt: new Date(),
        })
        .where(eq(refundAllocations.id, alloc.id));

      const aggregateStatus = await recomputeRefundRequestStatus(rr.id, txDb);
      await txDb
        .update(refundRequests)
        .set({ status: aggregateStatus, updatedAt: new Date() })
        .where(eq(refundRequests.id, rr.id));

      await txDb
        .update(stripeWebhookEvents)
        .set({ processingStatus: "processed", processedAt: new Date() })
        .where(eq(stripeWebhookEvents.id, eventRowId));
    });
  } else {
    // Non-terminal status (pending, requires_action) — update status only, no ledger
    await db
      .update(refundAllocations)
      .set({ providerStatus: internalStatus, updatedAt: new Date() })
      .where(eq(refundAllocations.id, alloc.id));

    await db
      .update(stripeWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, eventRowId));
  }
}

// ─── refund.failed ────────────────────────────────────────────────────────────
//
// Stripe sends refund.failed as a supplemental event; it carries the same
// information as refund.updated with status=failed. Route through the same
// handler to keep logic in one place.

async function handleRefundFailed(
  event: Stripe.Event,
  eventRowId: string,
): Promise<void> {
  return handleRefundUpdated(event, eventRowId);
}

// ─── Actual fee reconciliation (best-effort) ──────────────────────────────────

async function reconcileActualFee(
  financialTransactionId: string,
  pi: Stripe.PaymentIntent,
): Promise<void> {
  const stripe = getStripeClient();
  const latestChargeId = pi.latest_charge;

  if (!latestChargeId || typeof latestChargeId !== "string") {
    return;
  }

  let balanceTransactionId: string | null = null;
  try {
    const charge = await stripe.charges.retrieve(latestChargeId);
    balanceTransactionId =
      typeof charge.balance_transaction === "string"
        ? charge.balance_transaction
        : null;
  } catch {
    // Charge not available in test mode — normal
    return;
  }

  if (!balanceTransactionId) return;

  let actualFeeCents: number | null = null;
  try {
    const bt = await stripe.balanceTransactions.retrieve(balanceTransactionId);
    actualFeeCents = bt.fee;
  } catch {
    // Balance transaction not available in test mode — normal
    return;
  }

  if (actualFeeCents !== null) {
    await db
      .update(financialTransactions)
      .set({
        processingFeeActualCents: actualFeeCents,
        updatedAt: new Date(),
      })
      .where(eq(financialTransactions.id, financialTransactionId));
  }
}

export default router;
