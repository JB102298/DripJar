/**
 * Saved Payment Methods — Phase 4E
 *
 * POST /payment-methods/setup
 *   Create a Stripe SetupIntent (usage='off_session') for card or ACH.
 *   Returns { clientSecret, setupIntentId } for the Stripe payment sheet.
 *
 * GET /payment-methods
 *   List all active/pending_verification saved payment methods for the authed user.
 *
 * DELETE /payment-methods/:id
 *   Remove a saved payment method.
 *   Returns 409 if any AutoDrip authorization in (active|paused|needs_attention)
 *   references this method — pausing alone is NOT sufficient.
 *
 * POST /payment-methods/:id/default
 *   Set a saved payment method as the default.
 *
 * POST /payment-methods/setup-confirm
 *   Called after SetupIntent succeeds on the client.
 *   Retrieves the PM from Stripe, creates the saved_payment_methods row.
 *
 * Security invariants:
 *   - stripe_customer_id always read from DB (never from client body)
 *   - stripe_payment_method_id verified to belong to this customer before persisting
 *   - No pk_live_ keys
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  savedPaymentMethods,
  autoDripAuthorizations,
  profiles,
  users,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { getStripeClient } from "../lib/stripe.js";
import { getOrCreateStripeCustomer } from "../lib/stripe-customer.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── POST /payment-methods/setup ──────────────────────────────────────────────

router.post("/payment-methods/setup", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { type } = req.body as { type?: unknown };

  if (type !== "card" && type !== "us_bank_account") {
    res.status(400).json({ error: "BadRequest", message: "type must be 'card' or 'us_bank_account'" });
    return;
  }

  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) {
    res.status(500).json({ error: "InternalError", message: "User not found" });
    return;
  }

  const stripeCustomerId = await getOrCreateStripeCustomer(userId, user.email);
  const stripe = getStripeClient();

  const paymentMethodTypes: string[] = type === "us_bank_account" ? ["us_bank_account"] : ["card"];

  const siParams: Record<string, unknown> = {
    customer: stripeCustomerId,
    usage: "off_session",
    payment_method_types: paymentMethodTypes,
    metadata: { dripjar_user_id: userId, type },
  };

  if (type === "us_bank_account") {
    siParams["payment_method_options"] = {
      us_bank_account: {
        financial_connections: { permissions: ["payment_method", "balances"] },
        verification_method: "automatic",
      },
    };
  }

  const si = await stripe.setupIntents.create(siParams as Parameters<typeof stripe.setupIntents.create>[0], {
    idempotencyKey: `dripjar-si-setup:${userId}:${type}:${Date.now()}`,
  });

  if (!si.client_secret) {
    res.status(500).json({ error: "InternalError", message: "SetupIntent created without client_secret" });
    return;
  }

  logger.info({ userId, type, setupIntentId: si.id }, "SetupIntent created for saved payment method");

  res.status(201).json({ setupIntentId: si.id, clientSecret: si.client_secret });
});

// ─── POST /payment-methods/setup-confirm ──────────────────────────────────────

router.post("/payment-methods/setup-confirm", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { setupIntentId } = req.body as { setupIntentId?: unknown };

  if (typeof setupIntentId !== "string" || !setupIntentId.trim()) {
    res.status(400).json({ error: "BadRequest", message: "setupIntentId is required" });
    return;
  }

  const stripe = getStripeClient();
  const [profileRow] = await db
    .select({ stripeCustomerId: profiles.stripeCustomerId })
    .from(profiles)
    .where(eq(profiles.userId, userId));

  if (!profileRow?.stripeCustomerId) {
    res.status(400).json({ error: "BadRequest", message: "No Stripe customer found for this user" });
    return;
  }

  let si;
  try {
    si = await stripe.setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
  } catch {
    res.status(404).json({ error: "NotFound", message: "SetupIntent not found" });
    return;
  }

  // Verify this SI belongs to this customer
  if (si.customer !== profileRow.stripeCustomerId) {
    res.status(403).json({ error: "Forbidden", message: "SetupIntent does not belong to this account" });
    return;
  }

  if (si.status !== "succeeded" && si.status !== "processing") {
    res.status(409).json({
      error: "Conflict",
      message: `SetupIntent status is '${si.status}' — must be 'succeeded' or 'processing'`,
    });
    return;
  }

  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  if (!pmId) {
    res.status(400).json({ error: "BadRequest", message: "SetupIntent has no attached payment method" });
    return;
  }

  // Verify PM belongs to this customer
  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(pmId);
  } catch {
    res.status(500).json({ error: "InternalError", message: "Failed to retrieve payment method from Stripe" });
    return;
  }

  if (pm.customer !== profileRow.stripeCustomerId) {
    res.status(403).json({ error: "Forbidden", message: "Payment method does not belong to this account" });
    return;
  }

  // Idempotent: check if already saved
  const [existing] = await db
    .select({ id: savedPaymentMethods.id })
    .from(savedPaymentMethods)
    .where(eq(savedPaymentMethods.stripePaymentMethodId, pmId));

  if (existing) {
    const [saved] = await db
      .select()
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.id, existing.id));
    res.status(200).json(serializePm(saved!));
    return;
  }

  // Determine status
  const pmType = pm.type as string;
  let status = "active";
  if (pmType === "us_bank_account") {
    // ACH: verified if SI succeeded instantly; pending_verification for micro-deposit
    status = si.status === "succeeded" ? "active" : "pending_verification";
  }

  // Determine if this should be default (first method for user)
  const existing2 = await db
    .select({ id: savedPaymentMethods.id })
    .from(savedPaymentMethods)
    .where(and(eq(savedPaymentMethods.userId, userId), eq(savedPaymentMethods.status, "active")));
  const isDefault = existing2.length === 0;

  // Extract display metadata
  let displayBrand: string | null = null;
  let last4: string | null = null;
  let bankName: string | null = null;

  if (pmType === "card" && pm.card) {
    displayBrand = pm.card.brand ?? null;
    last4 = pm.card.last4 ?? null;
  } else if (pmType === "us_bank_account" && pm.us_bank_account) {
    bankName = pm.us_bank_account.bank_name ?? null;
    last4 = pm.us_bank_account.last4 ?? null;
  }

  const [inserted] = await db
    .insert(savedPaymentMethods)
    .values({
      userId,
      stripeCustomerId: profileRow.stripeCustomerId,
      stripePaymentMethodId: pmId,
      type: pmType as "card" | "us_bank_account",
      displayBrand,
      last4,
      bankName,
      isDefault,
      status: status as "active" | "pending_verification" | "detached",
    })
    .returning();

  if (!inserted) {
    res.status(500).json({ error: "InternalError", message: "Failed to save payment method" });
    return;
  }

  logger.info({ userId, pmId, type: pmType, status }, "Saved payment method created");
  res.status(201).json(serializePm(inserted));
});

// ─── GET /payment-methods ──────────────────────────────────────────────────────

router.get("/payment-methods", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;

  const methods = await db
    .select()
    .from(savedPaymentMethods)
    .where(
      and(
        eq(savedPaymentMethods.userId, userId),
        inArray(savedPaymentMethods.status, ["active", "pending_verification"]),
      ),
    );

  res.json(methods.map(serializePm));
});

// ─── DELETE /payment-methods/:id ──────────────────────────────────────────────

router.delete("/payment-methods/:id", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { id } = req.params as { id: string };

  const [pm] = await db
    .select()
    .from(savedPaymentMethods)
    .where(and(eq(savedPaymentMethods.id, id), eq(savedPaymentMethods.userId, userId)));

  if (!pm) {
    res.status(404).json({ error: "NotFound", message: "Payment method not found" });
    return;
  }

  if (pm.status === "detached") {
    res.status(409).json({ error: "Conflict", message: "Payment method is already detached" });
    return;
  }

  // Check for active AutoDrip authorizations referencing this method.
  // Pausing alone is NOT sufficient — paused authorizations retain the reference.
  const [blockingAuth] = await db
    .select({ id: autoDripAuthorizations.id, status: autoDripAuthorizations.status })
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.savedPaymentMethodId, id),
        inArray(autoDripAuthorizations.status, ["active", "paused", "needs_attention"]),
      ),
    )
    .limit(1);

  if (blockingAuth) {
    res.status(409).json({
      error: "Conflict",
      message:
        "This payment method is referenced by an AutoDrip authorization. " +
        "Change the AutoDrip to use a different payment method, or cancel the AutoDrip, before removing this method.",
    });
    return;
  }

  // Detach from Stripe
  try {
    const stripe = getStripeClient();
    await stripe.paymentMethods.detach(pm.stripePaymentMethodId);
  } catch (err) {
    logger.warn(
      { err: { message: (err as Error).message }, pmId: pm.stripePaymentMethodId },
      "Failed to detach payment method from Stripe (proceeding with DB update)",
    );
  }

  await db
    .update(savedPaymentMethods)
    .set({ status: "detached", isDefault: false, updatedAt: new Date() })
    .where(eq(savedPaymentMethods.id, id));

  // If this was the default, promote another active method
  if (pm.isDefault) {
    const [next] = await db
      .select({ id: savedPaymentMethods.id })
      .from(savedPaymentMethods)
      .where(
        and(
          eq(savedPaymentMethods.userId, userId),
          eq(savedPaymentMethods.status, "active"),
        ),
      )
      .limit(1);

    if (next) {
      await db
        .update(savedPaymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(savedPaymentMethods.id, next.id));
    }
  }

  res.status(204).send();
});

// ─── POST /payment-methods/:id/default ────────────────────────────────────────

router.post("/payment-methods/:id/default", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { id } = req.params as { id: string };

  const [pm] = await db
    .select({ id: savedPaymentMethods.id, status: savedPaymentMethods.status })
    .from(savedPaymentMethods)
    .where(and(eq(savedPaymentMethods.id, id), eq(savedPaymentMethods.userId, userId)));

  if (!pm) {
    res.status(404).json({ error: "NotFound", message: "Payment method not found" });
    return;
  }

  if (pm.status !== "active") {
    res.status(409).json({ error: "Conflict", message: "Only active payment methods can be set as default" });
    return;
  }

  // Unset current default, set new default in a transaction
  await db.transaction(async (tx) => {
    type DbOrTx = typeof db;
    const txDb = tx as unknown as DbOrTx;
    await txDb
      .update(savedPaymentMethods)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(savedPaymentMethods.userId, userId));
    await txDb
      .update(savedPaymentMethods)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(savedPaymentMethods.id, id));
  });

  res.status(200).json({ success: true });
});

// ─── Serializer ────────────────────────────────────────────────────────────────

function serializePm(pm: typeof savedPaymentMethods.$inferSelect) {
  return {
    id: pm.id,
    type: pm.type,
    displayBrand: pm.displayBrand,
    last4: pm.last4,
    bankName: pm.bankName,
    isDefault: pm.isDefault,
    status: pm.status,
    createdAt: pm.createdAt,
  };
}

export default router;
