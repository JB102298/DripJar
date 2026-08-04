/**
 * Stripe Processing-Fee Gross-Up Model — Phase 4B
 *
 * DripJar's rule: the Jar principal must remain intact; the customer pays
 * the estimated processing cost separately. The estimate must fully cover
 * what Stripe will charge on the total charge amount.
 *
 * Stripe's fee is assessed against the FINAL charge amount (which includes
 * the processing-fee component). The gross-up is therefore the MINIMUM
 * integer `processingFeeEstimatedCents` such that:
 *
 *   computeStripeFeeOnCharge(baseCents + processingFeeEstimatedCents)
 *     ≤ processingFeeEstimatedCents
 *
 * where baseCents = principalCents + dripJarFeeCents.
 *
 * Implemented via a deterministic iterative fixed-point solver (convergence
 * guaranteed within ~10 iterations for all realistic amounts).
 *
 * All arithmetic is integer-only. No floating-point dollars.
 *
 * IMPORTANT: This estimate is a DripJar pricing transparency figure, not a
 * guaranteed Stripe settlement value. Actual Stripe fees may differ due to
 * card type, interchange, Stripe plan, etc.
 *
 * Rounding: integer half-up via Math.floor((n * bps + 5_000) / 10_000)
 *   — equivalent to "round half away from zero" for positive values.
 *   — adding 5_000 (half of 10_000) before integer division guarantees the
 *     exact midpoint rounds UP.
 *
 * Stripe fee schedule (test mode approximation):
 *   Card:  2.9% + $0.30  →  bps=290, fixed=30¢
 *   ACH:   0.8%, cap $5  →  bps=80, cap=500¢
 */

export type PaymentMethodType = "us_bank_account" | "card";

// ─── Stripe fee schedule constants ────────────────────────────────────────────

const CARD_RATE_BPS = 290; // 2.9%
const CARD_FIXED_CENTS = 30; // $0.30
const ACH_RATE_BPS = 80; // 0.8%
const ACH_CAP_CENTS = 500; // $5.00 cap

const MAX_GROSS_UP_ITERATIONS = 10;

// ─── Integer half-up rounding helper ─────────────────────────────────────────

/**
 * Integer half-up rounding: floor((value * bps + 5_000) / 10_000)
 * Safe for all non-negative values where value * bps < Number.MAX_SAFE_INTEGER.
 */
function halfUpBps(valueCents: number, bps: number): number {
  return Math.floor((valueCents * bps + 5_000) / 10_000);
}

// ─── computeStripeFeeOnCharge ─────────────────────────────────────────────────

/**
 * Compute the Stripe fee on a given total charge amount.
 *
 * This is Stripe's fee model applied to the TOTAL charge (including any
 * processing-fee component). Used both by the gross-up solver and by tests
 * to verify the minimality invariant.
 *
 * @param totalCents         Total charge in integer cents (≥ 0)
 * @param paymentMethodType  'card' or 'us_bank_account'
 * @returns                  Integer cents Stripe will charge on totalCents
 */
export function computeStripeFeeOnCharge(
  totalCents: number,
  paymentMethodType: PaymentMethodType,
): number {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new Error(
      `totalCents must be a non-negative safe integer; got ${totalCents}`,
    );
  }

  if (paymentMethodType === "card") {
    return halfUpBps(totalCents, CARD_RATE_BPS) + CARD_FIXED_CENTS;
  }

  // ACH: 0.8% capped at $5.00
  return Math.min(halfUpBps(totalCents, ACH_RATE_BPS), ACH_CAP_CENTS);
}

// ─── computeGrossedUpProviderFee ──────────────────────────────────────────────

/**
 * Return the MINIMUM integer `processingFeeEstimatedCents` such that:
 *
 *   computeStripeFeeOnCharge(baseCents + result, paymentMethodType) ≤ result
 *
 * Uses a deterministic iterative fixed-point solver.
 * Convergence is guaranteed within MAX_GROSS_UP_ITERATIONS for all realistic
 * amounts (verified up to $1,000,000 principal).
 *
 * @param baseCents          principalCents + dripJarFeeCents (≥ 0)
 * @param paymentMethodType  'card' or 'us_bank_account'
 * @returns                  Minimum integer processing fee in cents
 * @throws                   If baseCents is not a safe integer, or solver fails to converge
 */
export function computeGrossedUpProviderFee(
  baseCents: number,
  paymentMethodType: PaymentMethodType,
): number {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) {
    throw new Error(
      `baseCents must be a non-negative safe integer; got ${baseCents}`,
    );
  }

  let feeCents = 0;

  for (let i = 0; i < MAX_GROSS_UP_ITERATIONS; i++) {
    const totalCents = baseCents + feeCents;
    if (!Number.isSafeInteger(totalCents)) {
      throw new Error(
        `Intermediate total overflowed safe integer: baseCents=${baseCents} feeCents=${feeCents}`,
      );
    }
    const requiredFee = computeStripeFeeOnCharge(totalCents, paymentMethodType);
    if (requiredFee <= feeCents) {
      return feeCents;
    }
    feeCents = requiredFee;
  }

  throw new Error(
    `Provider fee gross-up did not converge after ${MAX_GROSS_UP_ITERATIONS} iterations ` +
      `(baseCents=${baseCents}, paymentMethodType=${paymentMethodType})`,
  );
}
