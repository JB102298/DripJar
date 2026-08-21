/**
 * Plain-language summary of the savings agreement, shown on the create-jar
 * rules step and anywhere else a member needs the gist before accepting.
 *
 * THIS IS A SUMMARY, NOT THE AGREEMENT. The document a member accepts is
 * generated server-side by `artifacts/api-server/src/lib/agreement.ts` and
 * stored per jar in `agreements.content`.
 *
 * WHY IT IS KEYED BY CLAUSE ID
 *
 * The previous rules screen listed four hand-written rules with no link to the
 * document at all, and one of them was wrong in the same way the old agreement
 * was: it said a majority vote decides before "the jar funds are spent",
 * implying the group can move an individual's money. Nothing tied the screen to
 * the document, so nothing caught it.
 *
 * Now every entry here carries the id of the clause it summarises, and
 * `agreement-parity.test.ts` on the API side fails if this list and
 * `AGREEMENT_CLAUSES` stop covering exactly the same ids, or if the versions
 * disagree. Summary and document can no longer drift apart silently.
 *
 * Adding a clause server-side without adding a summary here is a build failure,
 * which is the intended pressure: a member should never accept a term that the
 * screen did not mention.
 */

/**
 * Must equal `AGREEMENT_VERSION` in the API's agreement.ts.
 *
 * This is a duplicated constant rather than an import because the mobile bundle
 * does not depend on the API server package. The parity test is what keeps the
 * duplication honest.
 */
export const AGREEMENT_VERSION = '2.0';

export interface AgreementShortRule {
  /** Clause id from the server-side agreement. Order here is display order. */
  id: string;
  /** Short heading shown on the rules card. */
  title: string;
  /** One or two sentences of plain language. */
  summary: string;
}

export const AGREEMENT_SHORT_RULES: readonly AgreementShortRule[] = [
  {
    id: 'contributions',
    title: 'Contributing is voluntary',
    summary:
      'You choose what to put in and when. A contribution target is a plan the group agreed on, not a bill.',
  },
  {
    id: 'saving-phase',
    title: 'Your savings stay yours',
    summary:
      'While the jar is saving, the money you put in is tracked as yours and you can ask for it back.',
  },
  {
    id: 'commitment-approval',
    title: 'The group decides together',
    summary:
      'Before the jar spends, the organizer proposes it and members vote. The vote is a decision to go ahead.',
  },
  {
    id: 'funding-commitment',
    title: 'Only you commit your money',
    summary:
      'After a proposal passes, each member funds their own share. No vote and no other member can commit your savings for you.',
  },
  {
    id: 'refunds',
    title: 'Refunds before you commit',
    summary:
      'You can request a refund of anything you have contributed but not committed. Money already committed or paid to a vendor follows their terms.',
  },
  {
    id: 'fees',
    title: 'Fees are shown up front',
    summary:
      'DripJar charges a service fee on each contribution, and processing fees may apply. You see both before you confirm. Fees are not refunded.',
  },
  {
    id: 'cancellation',
    title: 'If the jar is cancelled',
    summary:
      'You can request a refund of what you contributed and have not committed. Money already paid out follows the vendor’s terms.',
  },
  {
    id: 'transparency',
    title: 'Everyone sees the same numbers',
    summary:
      'Members can see the goal, the progress, each member’s contributions, and the jar’s activity history.',
  },
  {
    id: 'test-mode',
    title: 'This build is in test mode',
    summary:
      'Payments are simulated and no real money moves. You will be asked to accept new terms before real payments are enabled.',
  },
] as const;

/** Clause ids covered by the summary, in display order. */
export const AGREEMENT_SHORT_RULE_IDS: readonly string[] = AGREEMENT_SHORT_RULES.map((r) => r.id);
