/**
 * Failure attribution: who or what is responsible when something does not pass.
 *
 * The rule this module exists to enforce is one sentence: silence is never
 * product attribution. If nothing established that the product is at fault, the
 * cause is UNKNOWN.
 *
 * The old behaviour was the exact inverse, and its comment stated the defect as
 * intent -- "the default for an unattributed failure is the product." That is
 * how the harness came to tell an adopter their software was broken when what
 * had actually happened was that the harness invented a port, failed to reach
 * it, and had no attribution to report. A tool that reports a product bug it
 * cannot substantiate is worse than one that reports nothing, because someone
 * will go looking for the bug.
 *
 * UNKNOWN is not a softer failure. The run still fails. What changes is what the
 * harness claims to know, and a verdict that says "this failed and I cannot tell
 * you why" sends an engineer to the right place: the harness configuration,
 * their environment, or the contract itself.
 */

/**
 * The causes a verdict may carry.
 *
 * Each says who must act. That is the test for whether a cause is worth having:
 * two causes that send the same person to the same place should be one cause.
 */
export const CAUSE = {
  /** The subject violated an accepted assertion. The product team acts. */
  PRODUCT: 'PRODUCT',

  /** The contract itself is unsound or unsatisfiable. The contract author acts. */
  CONTRACT_INVALID: 'CONTRACT_INVALID',

  /**
   * A binding did not resolve to anything runnable -- a port nothing listens on,
   * an unreachable URL, a missing credential. Whoever configured the run acts.
   * This is the cause the old default was stealing from: an invented port is a
   * binding problem, and calling it a product bug sends the wrong person hunting.
   */
  BINDING_INVALID: 'BINDING_INVALID',

  /** Docker, the browser, the network, the disk. The operator acts. */
  HARNESS_ENVIRONMENT: 'HARNESS_ENVIRONMENT',

  /** The harness itself is broken or misconfigured. We act. */
  HARNESS_INTERNAL: 'HARNESS_INTERNAL',

  /** Evidence is missing, mutated, or does not verify. Nothing can be concluded. */
  EVIDENCE_INVALID: 'EVIDENCE_INVALID',

  /**
   * Something failed and nothing established who is responsible.
   *
   * This is a real verdict, not a fallback to be tidied away later. It is the
   * honest output when attribution was not determined, and it must stay
   * cheap to emit -- the moment UNKNOWN feels embarrassing, someone will start
   * guessing PRODUCT again.
   */
  UNKNOWN: 'UNKNOWN',
};

export const CAUSES = Object.values(CAUSE);

/** Causes that accuse the subject. These carry the burden of proof. */
const ACCUSING_CAUSES = new Set([CAUSE.PRODUCT]);

/**
 * Values that mean "the probe did not attribute this failure."
 *
 * A probe reports `cause: 'NONE'` alongside a pass, so an inverted `passed` flag
 * can reach attribution carrying 'NONE'. Absent, empty and 'NONE' all mean the
 * same thing: nobody said who was responsible.
 */
function isUnattributed(reported) {
  return !reported || reported === 'NONE' || reported === 'UNKNOWN';
}

/**
 * Certification modes. One engine, two eligibilities.
 *
 * EXPLORATORY exists so a draft can be run for feedback before anyone accepts
 * it -- which is how authoring works in practice. What it may not do is produce
 * an authoritative accusation, because there is no accepted assertion for the
 * subject to have violated. Without an accepted contract there is no promise,
 * and without a promise nothing can have been broken.
 */
export const MODE = {
  CERTIFYING: 'CERTIFYING',
  EXPLORATORY: 'EXPLORATORY',
};

/**
 * Attribute a failure.
 *
 * @param {object}  failure
 * @param {string}  [failure.reported]   The cause a probe reported, if any.
 * @param {boolean} [failure.hasAcceptedAssertion]  Was an accepted assertion
 *   violated? Product attribution is meaningless without one.
 * @param {boolean} [failure.hasSupportingEvidence]  Did evidence actually
 *   establish the product's behaviour, as opposed to the run merely failing?
 * @param {string}  [mode]  CERTIFYING or EXPLORATORY.
 *
 * @returns {{cause: string, authoritative: boolean, rationale: string}}
 *   `authoritative` says whether this attribution may be reported as a finding
 *   about the subject. A non-authoritative PRODUCT reading is downgraded, never
 *   silently relabelled -- the rationale records what was observed and why it
 *   does not carry.
 */
export function attributeFailure(failure = {}, mode = MODE.CERTIFYING) {
  const {
    reported,
    hasAcceptedAssertion = false,
    hasSupportingEvidence = false,
  } = failure;

  if (isUnattributed(reported)) {
    return {
      cause: CAUSE.UNKNOWN,
      authoritative: false,
      rationale:
        'The failure carried no attribution. Silence is not evidence against ' +
        'the product, so no cause is claimed.',
    };
  }

  if (!CAUSES.includes(reported)) {
    // An unrecognised cause is a harness problem, not a licence to guess. It
    // must not fall through to PRODUCT, and it must not be dropped -- a cause
    // the evaluator cannot interpret means the evaluator and its probes
    // disagree about the vocabulary.
    return {
      cause: CAUSE.HARNESS_INTERNAL,
      authoritative: true,
      rationale: `A probe reported an unrecognised cause "${reported}".`,
    };
  }

  if (!ACCUSING_CAUSES.has(reported)) {
    // Non-accusing causes need no burden of proof: they point at the harness,
    // the environment, the bindings or the contract -- all things the operator
    // can inspect directly, and none of which blame the subject.
    return { cause: reported, authoritative: true, rationale: 'Attributed by the probe.' };
  }

  // From here on the cause is PRODUCT, which accuses the subject and therefore
  // has to be earned.

  if (mode === MODE.EXPLORATORY) {
    return {
      cause: CAUSE.UNKNOWN,
      authoritative: false,
      rationale:
        'An exploratory run cannot make an authoritative product finding: ' +
        'nothing has been accepted, so there is no promise to have been broken. ' +
        'The failure is real and worth investigating; the attribution is not ' +
        'certified.',
    };
  }

  if (!hasAcceptedAssertion) {
    return {
      cause: CAUSE.UNKNOWN,
      authoritative: false,
      rationale:
        'The failure was attributed to the product, but no accepted assertion ' +
        'covers it. A product bug is the violation of a promise; with no ' +
        'promise there is nothing to violate.',
    };
  }

  if (!hasSupportingEvidence) {
    return {
      cause: CAUSE.UNKNOWN,
      authoritative: false,
      rationale:
        'The failure was attributed to the product, but no evidence establishes ' +
        'the product behaved as claimed. A failure to observe is not an ' +
        'observation of failure.',
    };
  }

  return {
    cause: CAUSE.PRODUCT,
    authoritative: true,
    rationale: 'An accepted assertion was violated and evidence supports the attribution.',
  };
}

/**
 * Whether a run in this mode may emit a certifying PASS.
 *
 * An exploratory run passing means "nothing went wrong today", which is useful
 * and is not a certificate. The distinction has to be structural, or the two
 * will be confused by exactly the person who most needs them separated.
 */
export function canCertify(mode) {
  return mode === MODE.CERTIFYING;
}
