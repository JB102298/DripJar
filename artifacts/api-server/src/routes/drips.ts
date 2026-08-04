/**
 * Drips Routes — Phase 4B
 *
 * POST /jars/:jarId/drips/payment-intent
 *   Create (or return existing) Stripe PaymentIntent for a persisted quote.
 *   Idempotent: returns existing PI on harmless client retry.
 *   Auth required + active jar membership.
 *
 * GET  /jars/:jarId/drips/:financialTransactionId/status
 *   Poll payment status for a drip. Auth required + membership check.
 *
 * Security boundaries:
 *   - Amount always read from DB (totalQuotedCents). Client never supplies it.
 *   - providerTransactionId not returned to client.
 *   - Stripe Customer ID not returned to client.
 *   - No setup_future_usage — one-time test drips only.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  financialTransactions,
  profiles,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { getStripeClient } from "../lib/stripe.js";
import { getOrCreateStripeCustomer } from "../lib/stripe-customer.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the authenticated user's jar_member row for the given jar. */
async function resolveActiveMember(userId: string, jarId: string) {
  const [member] = await db
    .select({ id: jarMembers.id, status: jarMembers.status })
    .from(jarMembers)
    .where(and(eq(jarMembers.userId, userId), eq(jarMembers.jarId, jarId)));
  return member;
}

// ─── POST /jars/:jarId/drips/payment-intent ────────────────────────────────────

router.post("/jars/:jarId/drips/payment-intent", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const { financialTransactionId } = req.body as { financialTransactionId?: unknown };

  // Validate input
  if (typeof financialTransactionId !== "string" || !financialTransactionId.trim()) {
    res.status(400).json({
      error: "BadRequest",
      message: "financialTransactionId is required",
    });
    return;
  }

  // Auth: caller must be an active member of the jar
  const [jar] = await db
    .select({ id: jars.id })
    .from(jars)
    .where(eq(jars.id, jarId));

  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const member = await resolveActiveMember(userId, jarId);
  if (!member || member.status !== "active") {
    res.status(403).json({
      error: "Forbidden",
      message: "You must be an active member of this jar to initiate a payment",
    });
    return;
  }

  // Load the financial transaction (authoritative data — never use client amounts)
  const [ft] = await db
    .select({
      id: financialTransactions.id,
      jarId: financialTransactions.jarId,
      memberId: financialTransactions.memberId,
      totalQuotedCents: financialTransactions.totalQuotedCents,
      currency: financialTransactions.currency,
      providerStatus: financialTransactions.providerStatus,
      providerTransactionId: financialTransactions.providerTransactionId,
      quoteExpiresAt: financialTransactions.quoteExpiresAt,
      paymentMethodCategory: financialTransactions.paymentMethodCategory,
    })
    .from(financialTransactions)
    .where(eq(financialTransactions.id, financialTransactionId));

  if (!ft) {
    res.status(404).json({
      error: "NotFound",
      message: "Financial transaction not found",
    });
    return;
  }

  // Ownership check: the financial transaction must belong to this member and jar
  if (ft.jarId !== jarId || ft.memberId !== member.id) {
    res.status(403).json({
      error: "Forbidden",
      message: "This quote does not belong to you in this jar",
    });
    return;
  }

  // Idempotent-retry logic
  if (
    ft.providerStatus === "provider_created" ||
    ft.providerStatus === "processing"
  ) {
    // Harmless retry — return the existing PaymentIntent's clientSecret
    if (!ft.providerTransactionId) {
      res.status(500).json({
        error: "InternalError",
        message: "Inconsistent payment state: status indicates PI created but no ID stored",
      });
      return;
    }
    const stripe = getStripeClient();
    const existingPi = await stripe.paymentIntents.retrieve(ft.providerTransactionId);
    const clientSecret = existingPi.client_secret;
    if (!clientSecret) {
      res.status(500).json({ error: "InternalError", message: "PaymentIntent has no client_secret" });
      return;
    }

    // Create a CustomerSession so PaymentSheet can work
    const profile = await db
      .select({ stripeCustomerId: profiles.stripeCustomerId })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .then((rows) => rows[0]);

    const customerId = profile?.stripeCustomerId;
    let customerSessionClientSecret: string | undefined;
    if (customerId) {
      const session = await stripe.customerSessions.create({
        customer: customerId,
        components: {
          mobile_payment_element: {
            enabled: true,
            features: {
              payment_method_save: "disabled",
              payment_method_remove: "disabled",
            },
          },
        },
      });
      customerSessionClientSecret = session.client_secret;
    }

    res.json({
      financialTransactionId: ft.id,
      clientSecret,
      ...(customerSessionClientSecret ? { customerSessionClientSecret } : {}),
    });
    return;
  }

  if (
    ft.providerStatus === "succeeded" ||
    ft.providerStatus === "failed" ||
    ft.providerStatus === "cancelled"
  ) {
    res.status(409).json({
      error: "Conflict",
      message: `This quote has already been ${ft.providerStatus}. Request a new quote.`,
    });
    return;
  }

  if (ft.providerStatus !== "quoted") {
    res.status(400).json({
      error: "BadRequest",
      message: `Expected providerStatus='quoted', got '${ft.providerStatus}'`,
    });
    return;
  }

  // Quote expiry check
  if (ft.quoteExpiresAt && ft.quoteExpiresAt < new Date()) {
    res.status(400).json({
      error: "BadRequest",
      message: "This quote has expired. Please request a new quote.",
    });
    return;
  }

  // Resolve payment method types
  const paymentMethodCategory = ft.paymentMethodCategory;
  if (
    paymentMethodCategory !== "us_bank_account" &&
    paymentMethodCategory !== "card"
  ) {
    res.status(400).json({
      error: "BadRequest",
      message: "Quote was created without a payment method type",
    });
    return;
  }

  // Get user's email for Stripe Customer lookup
  const [userProfile] = await db
    .select({
      email: profiles.userId,
      stripeCustomerId: profiles.stripeCustomerId,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId));

  // Get user's email from users table
  const { users } = await import("@workspace/db");
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    res.status(500).json({ error: "InternalError", message: "User not found" });
    return;
  }

  const stripeCustomerId = await getOrCreateStripeCustomer(userId, user.email);
  const stripe = getStripeClient();

  // Build payment method options
  const paymentMethodOptions: Record<string, unknown> = {};
  if (paymentMethodCategory === "us_bank_account") {
    paymentMethodOptions["us_bank_account"] = {
      financial_connections: {
        permissions: ["payment_method", "balances"],
      },
      verification_methods: ["automatic"],
    };
  }

  // Create the PaymentIntent
  // Idempotency key is the financial_transaction UUID — ensures exactly one PI per quote
  const pi = await stripe.paymentIntents.create(
    {
      amount: ft.totalQuotedCents,
      currency: ft.currency.toLowerCase(),
      customer: stripeCustomerId,
      payment_method_types: [paymentMethodCategory],
      ...(Object.keys(paymentMethodOptions).length > 0
        ? { payment_method_options: paymentMethodOptions }
        : {}),
      // No setup_future_usage — Phase 4B is one-time test drips only
      metadata: {
        financialTransactionId: ft.id,
        jarId,
        memberId: member.id,
      },
    },
    {
      idempotencyKey: ft.id,
    },
  );

  if (!pi.client_secret) {
    throw new Error("Stripe PaymentIntent created without a client_secret");
  }

  // Persist the PaymentIntent ID and update status
  await db
    .update(financialTransactions)
    .set({
      providerType: "stripe",
      providerTransactionId: pi.id,
      providerStatus: "provider_created",
      updatedAt: new Date(),
    })
    .where(eq(financialTransactions.id, ft.id));

  // Create a CustomerSession for PaymentSheet
  const session = await stripe.customerSessions.create({
    customer: stripeCustomerId,
    components: {
      mobile_payment_element: {
        enabled: true,
        features: {
          payment_method_save: "disabled",
          payment_method_remove: "disabled",
        },
      },
    },
  });

  logger.info(
    { financialTransactionId: ft.id, piId: pi.id, jarId, paymentMethodCategory },
    "Stripe PaymentIntent created",
  );

  res.json({
    financialTransactionId: ft.id,
    clientSecret: pi.client_secret,
    customerSessionClientSecret: session.client_secret,
  });
});

// ─── GET /jars/:jarId/drips/:financialTransactionId/status ────────────────────

router.get(
  "/jars/:jarId/drips/:financialTransactionId/status",
  requireAuth,
  async (req, res) => {
    const userId = (req as unknown as AuthenticatedRequest).userId;
    const { jarId, financialTransactionId } = req.params as {
      jarId: string;
      financialTransactionId: string;
    };

    // Auth: caller must be a member of the jar OR the jar organizer
    const [jar] = await db
      .select({ organizerId: jars.organizerId })
      .from(jars)
      .where(eq(jars.id, jarId));

    if (!jar) {
      res.status(404).json({ error: "NotFound", message: "Jar not found" });
      return;
    }

    const member = await resolveActiveMember(userId, jarId);
    const isOrganizer = jar.organizerId === userId;
    const isMember = !!member;

    if (!isOrganizer && !isMember) {
      res.status(403).json({ error: "Forbidden", message: "Access denied" });
      return;
    }

    // Load the financial transaction
    const [ft] = await db
      .select({
        id: financialTransactions.id,
        jarId: financialTransactions.jarId,
        memberId: financialTransactions.memberId,
        providerStatus: financialTransactions.providerStatus,
        ledgerPostingStatus: financialTransactions.ledgerPostingStatus,
        requestedPrincipalCents: financialTransactions.requestedPrincipalCents,
        totalQuotedCents: financialTransactions.totalQuotedCents,
        paymentMethodCategory: financialTransactions.paymentMethodCategory,
        createdAt: financialTransactions.createdAt,
      })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, financialTransactionId));

    if (!ft) {
      res.status(404).json({
        error: "NotFound",
        message: "Financial transaction not found",
      });
      return;
    }

    // Ownership check: organizer can see all, members can only see own
    if (!isOrganizer && ft.memberId !== member?.id) {
      res.status(403).json({ error: "Forbidden", message: "Access denied" });
      return;
    }

    if (ft.jarId !== jarId) {
      res.status(403).json({ error: "Forbidden", message: "Access denied" });
      return;
    }

    res.json({
      financialTransactionId: ft.id,
      providerStatus: ft.providerStatus,
      ledgerPostingStatus: ft.ledgerPostingStatus,
      principalCents: ft.requestedPrincipalCents,
      totalQuotedCents: ft.totalQuotedCents,
      paymentMethodCategory: ft.paymentMethodCategory,
      createdAt: ft.createdAt,
    });
  },
);

export default router;
