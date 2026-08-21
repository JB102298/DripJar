/**
 * DripJar Savings Agreement — canonical source.
 *
 * ─── INTERNAL: PROFESSIONAL LEGAL REVIEW REQUIRED ───────────────────────────
 *
 * This wording was written by the engineering team to describe what the system
 * actually does. It has NOT been reviewed by a lawyer. It must be reviewed by
 * qualified counsel before real money moves through the platform. The marker
 * below exists so that requirement is a value in the codebase that a launch
 * check can assert on, not a comment someone has to remember to read.
 *
 * See `AGREEMENT_REQUIRES_LEGAL_REVIEW`. Do not flip it to `false` as part of
 * unrelated work.
 *
 * ─── WHY 2.0 EXISTS ──────────────────────────────────────────────────────────
 *
 * Version 1.0 misdescribed the system in a way that mattered. It said funds
 * become committed "once a Commitment Request is approved and the Lock Date has
 * passed" — i.e. that the group's vote moves members' money.
 *
 * It does not, and never has. `routes/commitments.ts` records votes and
 * resolves the request's status; it calls no ledger primitive at all — no
 * `postCommitPrincipal`, no `CTRB_COMMITTED` posting. Principal moves only
 * through `routes/fund-commitment.ts`, which is scoped to the caller's own
 * `member.id` and rejects a snapshot whose ownership does not match. A vote
 * decides *whether the group will do the thing*; each member then moves their
 * own money, or does not.
 *
 * A member reading 1.0 would reasonably believe a majority could commit their
 * savings without them. Correcting that is a copy fix, not a behaviour change:
 * the code already worked the safer way.
 *
 * 2.0 also names the DripJar fee, which 1.0 never mentioned despite charging it
 * on every contribution.
 *
 * ─── IMMUTABILITY ────────────────────────────────────────────────────────────
 *
 * Agreements are per-jar rows. Editing this file changes the text stored on
 * jars created AFTERWARDS. It does not and must not touch rows already written:
 * a member accepted a specific wording on a specific date, and that record is
 * evidence. Nothing in the codebase updates an `agreements` row — acceptance
 * checks are per-agreement-id, so a jar moved to a new version simply requires
 * everyone to accept again (`lib/agreement-check.ts`). `agreement-immutability`
 * in the test suite pins this.
 *
 * ─── CLAUSE IDS ──────────────────────────────────────────────────────────────
 *
 * Clause ids are a stable contract, not display strings. The mobile rules
 * screen keys its plain-language summary off exactly these ids
 * (`artifacts/mobile/lib/agreement-rules.ts`) so the summary a member reads
 * before accepting cannot drift out of sync with the document they accept.
 * `agreement-parity.test.ts` fails the build if the two lists diverge.
 *
 * Renaming an id is a breaking change. Add a clause, or reword a body; do not
 * repurpose an id.
 */

/**
 * Version written to `agreements.version` for newly created jars.
 *
 * Bumping this does NOT migrate existing jars. Members of a jar that adopts a
 * new version must re-accept, because acceptance is recorded against an
 * agreement id.
 */
export const AGREEMENT_VERSION = "2.0";

/**
 * INTERNAL launch gate. `true` means the agreement text has not been through
 * professional legal review and the product must not process real money.
 *
 * Deliberately not exposed on any API response — it is an internal engineering
 * marker, not a customer-facing disclosure. The customer-facing statement about
 * test-mode payments is the `test-mode` clause below.
 */
export const AGREEMENT_REQUIRES_LEGAL_REVIEW = true;

export interface AgreementClause {
  /** Stable identifier. Shared with the mobile short-rules list. Never reuse. */
  id: string;
  /** Heading as rendered in the stored document. */
  heading: string;
  /** Full clause text as rendered in the stored document. */
  body: string;
}

/**
 * The document, in order.
 *
 * Ordering is deliberate: what happens to your money (1–2), how the group makes
 * decisions (3–4), how you get money back (5–6), what happens if it all stops
 * (7), what everyone can see (8), and the current test-mode caveat (9).
 */
export const AGREEMENT_CLAUSES: readonly AgreementClause[] = [
  {
    id: "contributions",
    heading: "YOUR CONTRIBUTIONS",
    body:
      "Contributions to this jar are voluntary. Each member decides what to contribute and when, subject to any schedule they set for themselves. A contribution target shown next to your name is a plan the group agreed on, not a debt DripJar will collect.",
  },
  {
    id: "saving-phase",
    heading: "THE SAVING PHASE",
    body:
      "While the jar is saving, the principal you have contributed remains yours. It is tracked separately from every other member's, and you may request a refund of it at any time, subject to the Refunds clause below.",
  },
  {
    id: "commitment-approval",
    heading: "GROUP APPROVAL",
    body:
      "Before the group spends from the jar, the Organizer submits a Commitment Request naming the amount and its purpose. Members vote, and the request passes at the jar's approval threshold. Approval is the group's decision to proceed. It does not, by itself, move any member's money.",
  },
  {
    id: "funding-commitment",
    heading: "FUNDING YOUR SHARE",
    body:
      "After a request is approved, each member funds their own share from their own contributed principal, and only that member can do so. Once you fund your share, that principal is committed to the stated purpose and can no longer be refunded on request. No other member, and no vote, can commit your principal for you.",
  },
  {
    id: "refunds",
    heading: "REFUNDS",
    body:
      "You may request a refund of principal you have contributed but not yet committed. Refunds are returned to the original payment method and are subject to review. Principal that has already been committed, or paid to a third party such as a vendor, airline, or venue, is subject to that party's terms and may not be recoverable.",
  },
  {
    id: "fees",
    heading: "FEES",
    body:
      "DripJar charges a service fee on each contribution, shown to you before you confirm it. Payment processing fees may also apply and are likewise shown before you confirm. Fees are not part of your refundable principal and are not returned when principal is refunded.",
  },
  {
    id: "cancellation",
    heading: "IF THE JAR IS CANCELLED",
    body:
      "If the jar is cancelled, each member may request a refund of the principal they have contributed and not committed. Committed principal follows the Refunds clause above. DripJar does not guarantee recovery of amounts already paid to third parties.",
  },
  {
    id: "transparency",
    heading: "TRANSPARENCY",
    body:
      "Every member of this jar can see the jar's goal and progress, each member's contribution target and contributed total, milestones, commitment requests and their votes, and the jar's activity history. Join this jar only if you are comfortable with the other members seeing your contributions.",
  },
  {
    id: "test-mode",
    heading: "TEST MODE",
    body:
      "This build of DripJar operates in test mode. Payments are simulated and no real money is transferred. The terms that will govern real-money transactions will be provided separately, and members will be asked to accept them, before real payment processing is enabled.",
  },
] as const;

/** Clause ids in document order. The contract the mobile summary keys off. */
export const AGREEMENT_CLAUSE_IDS: readonly string[] = AGREEMENT_CLAUSES.map((c) => c.id);

const AGREEMENT_TITLE = "DripJar Savings Agreement";

const AGREEMENT_CLOSING =
  "All members agree to treat each other fairly and to communicate openly about any inability to meet a contribution schedule.";

/**
 * Render the stored document.
 *
 * Numbering is derived from clause order rather than hard-coded, so inserting a
 * clause cannot leave the document with two "4."s. The output is what is
 * written to `agreements.content` and what a member reads and accepts.
 */
export function renderAgreementText(): string {
  const clauses = AGREEMENT_CLAUSES.map(
    (clause, index) => `${index + 1}. ${clause.heading}: ${clause.body}`,
  ).join("\n\n");

  return `${AGREEMENT_TITLE} (v${AGREEMENT_VERSION})\n\n${clauses}\n\n${AGREEMENT_CLOSING}`;
}

/** Look up a clause by id. Returns undefined for an unknown id. */
export function getAgreementClause(id: string): AgreementClause | undefined {
  return AGREEMENT_CLAUSES.find((c) => c.id === id);
}
