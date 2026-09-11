/**
 * Exit codes, defined by what an automated caller should do about them.
 *
 * The test for whether a code earns its place is whether CI would branch on it.
 * Five do. Anything finer belongs in the output, where a human reads it, not in
 * a number a script switches on.
 *
 *   0  The thing you asked for held.
 *   1  The subject broke an accepted promise. Your software; go look at it.
 *   2  Nothing was proven. Not a pass, not an accusation -- the run could not
 *      establish the claim, or was never entitled to. This is where an
 *      exploratory run lands even when everything it tried succeeded.
 *   3  You asked for something incoherent: bad usage, an invalid contract, a
 *      binding that resolves to nothing. Nothing ran.
 *   4  The harness or its environment failed, or evidence did not verify.
 *      Nothing can be concluded about the subject either way.
 *
 * The distinction between 1 and 2 is the one that matters most, and it is the
 * one the old code collapsed: an unattributed failure was reported as a product
 * bug, so CI could not tell "your software is broken" from "we could not tell."
 * The distinction between 2 and 4 matters nearly as much -- an unproven result
 * is an honest outcome, while a harness failure is our fault.
 */

export const EXIT = {
  OK: 0,
  ASSERTION_FAILED: 1,
  UNPROVEN: 2,
  USAGE_OR_CONTRACT: 3,
  HARNESS_OR_INTEGRITY: 4,
};

export const EXIT_MEANING = {
  0: 'ok',
  1: 'an accepted assertion was violated',
  2: 'nothing was proven',
  3: 'usage, contract or binding problem; nothing ran',
  4: 'harness, environment or evidence-integrity failure',
};

/**
 * Map an adjudicated cause to the exit code an automated caller needs.
 *
 * Only a substantiated product finding exits 1. Everything unattributed lands
 * on 2, which is the whole point: silence must not be reported to CI as an
 * accusation.
 */
export function exitCodeForCause(cause) {
  switch (cause) {
    case 'PRODUCT':
      return EXIT.ASSERTION_FAILED;
    case 'CONTRACT_INVALID':
    case 'BINDING_INVALID':
      return EXIT.USAGE_OR_CONTRACT;
    case 'HARNESS_ENVIRONMENT':
    case 'HARNESS_INTERNAL':
    case 'EVIDENCE_INVALID':
      return EXIT.HARNESS_OR_INTEGRITY;
    case 'UNKNOWN':
    default:
      return EXIT.UNPROVEN;
  }
}
