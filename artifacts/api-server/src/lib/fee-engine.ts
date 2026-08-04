/**
 * DripJar Fee Engine
 *
 * Server-authoritative fee calculation. Clients never provide or override
 * fee components — they supply only the intended principal, and all fees
 * are derived here.
 *
 * Rounding: integer half-up (Math.round on cents arithmetic).
 *
 * Examples:
 *   computeDripJarFee(20000) → 600   ($200.00 → $6.00)
 *   computeDripJarFee(10000) → 300   ($100.00 → $3.00)
 *   computeDripJarFee(100)   → 3     ($1.00   → $0.03)
 *   computeDripJarFee(34)    → 1     ($0.34   → $0.01, rounds up from 1.02)
 *   computeDripJarFee(16)    → 0     ($0.16   → $0.00, rounds down from 0.48)
 *   computeDripJarFee(17)    → 1     ($0.17   → $0.01, rounds up from 0.51)
 */

/** Current DripJar service fee rate in basis points (300 bps = 3%). */
export const DRIPJAR_FEE_RATE_BPS = 300;

export interface FinancialQuote {
  /** Intended principal in integer cents. */
  principalCents: number;
  /** DripJar service fee (server-computed, non-refundable). */
  dripJarFeeCents: number;
  /** Provider processing-fee estimate (0 in Phase 4A; populated in 4B+). */
  estimatedProcessingFeeCents: number;
  /** Sum of all three components = what the customer is charged. */
  totalChargeCents: number;
  /** ISO 4217 currency code. */
  currency: string;
  /**
   * Fee rate used to compute dripJarFeeCents, stored on every quote so
   * clients can display the rate and so historical records remain stable
   * if the rate changes in a future version.
   */
  feeRateBps: number;
}

/**
 * Compute the DripJar service fee for a given principal.
 *
 * Formula: Math.round(principal × rateBps / 10_000)
 *
 * The rate is applied server-side only. Callers cannot pass a custom rate
 * through any public API.
 *
 * @param principalCents  Non-negative integer cents.
 * @param rateBps         Fee rate in basis points (defaults to DRIPJAR_FEE_RATE_BPS).
 */
export function computeDripJarFee(
  principalCents: number,
  rateBps: number = DRIPJAR_FEE_RATE_BPS,
): number {
  if (!Number.isInteger(principalCents) || principalCents < 0) {
    throw new Error(`principalCents must be a non-negative integer; got ${principalCents}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error(`rateBps must be an integer in [0, 10000]; got ${rateBps}`);
  }
  // Integer arithmetic with half-up rounding.
  // No floating-point accumulation: multiplication is exact for values within
  // safe integer range (principalCents < 2^53 / 10000).
  return Math.round((principalCents * rateBps) / 10_000);
}

/**
 * Generate a server-authoritative financial quote for a drip.
 *
 * The client provides only the intended principal. All fee components are
 * computed here. The returned quote object is suitable for:
 *   - Displaying a pre-confirmation breakdown to the user.
 *   - Creating a financial_transaction record with all components frozen.
 *   - Reuse by Phase 4B (Stripe) when building a PaymentIntent.
 *
 * In Phase 4A there is no live payment provider, so estimatedProcessingFeeCents
 * defaults to 0. Phase 4B will supply a real estimate based on the Stripe fee
 * schedule.
 *
 * @param principalCents              Intended principal in integer cents (≥ 1).
 * @param estimatedProcessingFeeCents Provider fee estimate (default 0).
 * @param currency                    ISO 4217 code (default 'USD').
 */
export function generateQuote(
  principalCents: number,
  estimatedProcessingFeeCents: number = 0,
  currency: string = "USD",
): FinancialQuote {
  if (!Number.isInteger(principalCents) || principalCents < 1) {
    throw new Error(`principalCents must be a positive integer; got ${principalCents}`);
  }
  if (!Number.isInteger(estimatedProcessingFeeCents) || estimatedProcessingFeeCents < 0) {
    throw new Error(
      `estimatedProcessingFeeCents must be a non-negative integer; got ${estimatedProcessingFeeCents}`,
    );
  }

  const dripJarFeeCents = computeDripJarFee(principalCents);
  const totalChargeCents = principalCents + dripJarFeeCents + estimatedProcessingFeeCents;

  return {
    principalCents,
    dripJarFeeCents,
    estimatedProcessingFeeCents,
    totalChargeCents,
    currency,
    feeRateBps: DRIPJAR_FEE_RATE_BPS,
  };
}

/**
 * Validate that a request body does NOT contain client-supplied fee overrides.
 * Call this on any route that accepts a principalCents input to ensure the
 * client cannot manipulate the computed fee.
 *
 * Returns a non-null error message string if a tampered field is detected,
 * or null if the body is clean.
 */
export function detectTamperedFeeFields(
  body: Record<string, unknown>,
): string | null {
  const forbidden = [
    "dripJarFeeCents",
    "dripjar_fee_cents",
    "totalChargeCents",
    "total_charge_cents",
    "feeRateBps",
    "fee_rate_bps",
    "processingFeeEstimatedCents",
    "processing_fee_estimated_cents",
  ];
  for (const field of forbidden) {
    if (field in body) {
      return `Field '${field}' is server-computed and cannot be provided by the client`;
    }
  }
  return null;
}
