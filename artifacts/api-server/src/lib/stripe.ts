/**
 * Stripe Client Factory — Phase 4B
 *
 * Provides a lazy-initialised, test-mode-guarded Stripe instance.
 *
 * Security invariants:
 *   - STRIPE_SECRET_KEY must start with 'sk_test_' — live keys hard-fail
 *   - Missing key hard-fails with a clear diagnostic message
 *   - Key contents are never logged
 *   - Instance is cached after first successful initialisation
 */

import Stripe from "stripe";

let _client: Stripe | null = null;

/**
 * Return the singleton Stripe client, initialising it on first call.
 *
 * @throws {Error} If STRIPE_SECRET_KEY is absent or does not start with 'sk_test_'.
 */
export function getStripeClient(): Stripe {
  if (_client) return _client;

  const key = process.env["STRIPE_SECRET_KEY"];

  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. " +
        "Set it to a Stripe test-mode secret key (sk_test_…) before starting the server.",
    );
  }

  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_SECRET_KEY must be a test-mode key (starting with 'sk_test_'). " +
        "Live keys (sk_live_…) are not permitted in this build.",
    );
  }

  _client = new Stripe(key, {
    apiVersion: "2026-07-29.dahlia",
    // Explicit telemetry opt-out — this server does not send Stripe telemetry
    telemetry: false,
  });

  return _client;
}

/**
 * Clear the cached Stripe instance.
 * Use ONLY in tests to reset state between test cases that inject
 * different STRIPE_SECRET_KEY values via process.env.
 */
export function _resetStripeClientForTests(): void {
  _client = null;
}
