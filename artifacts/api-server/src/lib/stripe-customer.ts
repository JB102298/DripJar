/**
 * Stripe Customer Linkage — Phase 4B
 *
 * getOrCreateStripeCustomer() ensures every DripJar user has at most one
 * Stripe Customer object, and handles concurrent calls + crash-between-
 * Stripe-and-DB scenarios safely.
 *
 * Safety mechanisms:
 *   1. SELECT FOR UPDATE inside a DB transaction prevents two concurrent
 *      callers from both issuing stripe.customers.create for the same user.
 *   2. Stripe idempotency key `dripjar-customer:<userId>` ensures that if
 *      Stripe creation succeeds but the DB write fails before persisting
 *      stripeCustomerId, a retry with the same key resolves to the same
 *      Stripe Customer rather than creating an orphan duplicate.
 *
 * The Stripe Customer ID is NEVER returned to clients as an authoritative
 * value — it is server-side plumbing only.
 */

import { db } from "@workspace/db";
import { profiles } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getStripeClient } from "./stripe.js";

/**
 * Return the Stripe Customer ID for a user, creating one if it does not exist.
 *
 * @param userId  DripJar user UUID
 * @param email   User's email address (stored in Stripe Customer metadata)
 * @returns       The Stripe Customer ID (cus_…)
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
): Promise<string> {
  type DbOrTx = typeof db;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as DbOrTx;

    // Lock the profile row to serialize concurrent first-time customer creation
    const [profile] = await txDb
      .select({
        id: profiles.id,
        stripeCustomerId: profiles.stripeCustomerId,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .for("update");

    if (!profile) {
      throw new Error(`Profile not found for userId=${userId}`);
    }

    // Already linked — return immediately (no Stripe API call)
    if (profile.stripeCustomerId) {
      return profile.stripeCustomerId;
    }

    // Create Stripe Customer.
    // Stable idempotency key: if Stripe succeeds but the DB write below fails
    // before persisting stripeCustomerId, a retry will resolve to the same
    // Customer object instead of creating a duplicate.
    const stripe = getStripeClient();
    const customer = await stripe.customers.create(
      {
        email,
        metadata: {
          dripjar_user_id: userId,
        },
      },
      {
        idempotencyKey: `dripjar-customer:${userId}`,
      },
    );

    // Persist the Customer ID — must succeed before we return
    await txDb
      .update(profiles)
      .set({
        stripeCustomerId: customer.id,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profile.id));

    return customer.id;
  });
}
