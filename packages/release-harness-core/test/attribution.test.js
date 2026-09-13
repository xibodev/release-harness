// Failure attribution: T-1 through T-4.
//
// One rule: silence is never product attribution. The shipped behaviour was the
// exact inverse -- an unattributed failure defaulted to PRODUCT_BUG -- and that
// is how the harness came to tell an adopter their software was broken when
// what had actually happened was that it invented a port, failed to reach it,
// and had nothing to report.
//
// These tests hold the inversion in place, including the case that is easiest
// to erode: UNKNOWN must stay cheap to emit. The moment it feels like a
// deficiency, someone will start guessing PRODUCT again.

import assert from 'node:assert';
import { attributeFailure, canCertify, CAUSE, CAUSES, MODE } from '../src/attribution.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nFailure attribution\n');

// A failure that has earned a product attribution: an accepted assertion was
// violated, and evidence establishes the behaviour.
const earned = {
  reported: CAUSE.PRODUCT,
  hasAcceptedAssertion: true,
  hasSupportingEvidence: true,
};

// ---------------------------------------------------------------------------
// T-1  An accepted assertion violated, with evidence, is a product finding.
// ---------------------------------------------------------------------------
{
  const verdict = attributeFailure(earned, MODE.CERTIFYING);

  assert.strictEqual(verdict.cause, CAUSE.PRODUCT, 'an evidenced violation is a product bug');
  assert.strictEqual(verdict.authoritative, true, 'and it is authoritative');

  pass('T-1', 'an evidenced violation of an accepted assertion is PRODUCT');
}

// ---------------------------------------------------------------------------
// T-4  An unattributed failure is UNKNOWN. (Tested before T-2/T-3: it is the
//      defect this module exists for.)
// ---------------------------------------------------------------------------
{
  // Every shape of "nobody said who was responsible" must reach UNKNOWN. The
  // 'NONE' case is the live one: probes report it alongside a pass, so an
  // inverted `passed` flag arrives here carrying it.
  for (const reported of [undefined, null, '', 'NONE', 'UNKNOWN']) {
    const verdict = attributeFailure({ reported }, MODE.CERTIFYING);
    assert.strictEqual(
      verdict.cause,
      CAUSE.UNKNOWN,
      `an unattributed failure (${JSON.stringify(reported)}) must be UNKNOWN, never PRODUCT`
    );
    assert.strictEqual(verdict.authoritative, false, 'and it must not be authoritative');
  }

  // Even with an accepted assertion and evidence present, silence attributes
  // nothing: those establish that a product finding is POSSIBLE, not that one
  // was made.
  assert.strictEqual(
    attributeFailure({ hasAcceptedAssertion: true, hasSupportingEvidence: true }).cause,
    CAUSE.UNKNOWN,
    'the presence of evidence does not manufacture an attribution'
  );

  // The rationale must say what happened, because "UNKNOWN" alone tells an
  // engineer nothing about where to look.
  const { rationale } = attributeFailure({}, MODE.CERTIFYING);
  assert.match(rationale, /no attribution/i, 'the verdict must explain itself');

  pass('T-4', 'an unattributed failure is UNKNOWN, never PRODUCT');
}

// ---------------------------------------------------------------------------
// T-4b  Product attribution carries a burden of proof.
//
// A probe saying PRODUCT is a claim, not a conclusion. Without an accepted
// assertion there is no promise to have been broken; without evidence there is
// a failure to observe rather than an observation of failure.
// ---------------------------------------------------------------------------
{
  const noAssertion = attributeFailure(
    { reported: CAUSE.PRODUCT, hasAcceptedAssertion: false, hasSupportingEvidence: true },
    MODE.CERTIFYING
  );
  assert.strictEqual(noAssertion.cause, CAUSE.UNKNOWN, 'no accepted assertion, no product bug');
  assert.match(noAssertion.rationale, /promise/, 'and the reason must be legible');

  const noEvidence = attributeFailure(
    { reported: CAUSE.PRODUCT, hasAcceptedAssertion: true, hasSupportingEvidence: false },
    MODE.CERTIFYING
  );
  assert.strictEqual(noEvidence.cause, CAUSE.UNKNOWN, 'no evidence, no product bug');
  assert.match(
    noEvidence.rationale,
    /failure to observe is not an observation of failure/,
    'the distinction must be stated where someone will read it'
  );

  pass('T-4b', 'product attribution requires an accepted assertion and evidence');
}

// ---------------------------------------------------------------------------
// T-3  Environment and harness failures are attributed away from the product.
//
// Docker not running is not a bug in the subject. These causes need no burden
// of proof because they accuse nobody -- they point at things the operator can
// go and look at.
// ---------------------------------------------------------------------------
{
  const cases = [
    [CAUSE.HARNESS_ENVIRONMENT, 'docker is not running'],
    [CAUSE.HARNESS_INTERNAL, 'the harness threw'],
    [CAUSE.BINDING_INVALID, 'nothing listens on the bound port'],
    [CAUSE.CONTRACT_INVALID, 'the contract is unsatisfiable'],
    [CAUSE.EVIDENCE_INVALID, 'evidence did not verify'],
  ];

  for (const [cause, what] of cases) {
    const verdict = attributeFailure(
      { reported: cause, hasAcceptedAssertion: false, hasSupportingEvidence: false },
      MODE.CERTIFYING
    );
    assert.strictEqual(verdict.cause, cause, `${what} must stay ${cause}`);
    assert.strictEqual(
      verdict.authoritative,
      true,
      `${cause} accuses nobody, so it needs no burden of proof`
    );
  }

  // An unrecognised cause is a harness problem -- the evaluator and its probes
  // disagree about the vocabulary. It must not fall through to PRODUCT and must
  // not be silently dropped.
  const unknownVocab = attributeFailure({ reported: 'KERNEL_PANIC_MAYBE' }, MODE.CERTIFYING);
  assert.strictEqual(
    unknownVocab.cause,
    CAUSE.HARNESS_INTERNAL,
    'an unrecognised cause is the harness\'s problem, not the product\'s'
  );
  assert.match(unknownVocab.rationale, /unrecognised/, 'and it must name the unrecognised value');

  pass('T-3', 'environment, binding and harness failures are not product bugs');
}

// ---------------------------------------------------------------------------
// T-2  An exploratory run can never make an authoritative product finding.
//
// Nothing has been accepted, so there is no promise to have been broken. The
// failure is still real and still worth investigating -- what it is not is
// certified.
// ---------------------------------------------------------------------------
{
  const verdict = attributeFailure(earned, MODE.EXPLORATORY);

  assert.strictEqual(
    verdict.cause,
    CAUSE.UNKNOWN,
    'an exploratory run must not emit an authoritative product finding'
  );
  assert.strictEqual(verdict.authoritative, false, 'nothing exploratory is authoritative');
  assert.match(
    verdict.rationale,
    /failure is real/,
    'the rationale must not read as if nothing happened'
  );

  // But exploratory runs still attribute the causes that accuse nobody --
  // otherwise the mode would be useless for the thing it exists for: telling
  // an author their environment is broken while they draft.
  assert.strictEqual(
    attributeFailure({ reported: CAUSE.HARNESS_ENVIRONMENT }, MODE.EXPLORATORY).cause,
    CAUSE.HARNESS_ENVIRONMENT,
    'an exploratory run must still report environment problems'
  );

  assert.strictEqual(canCertify(MODE.EXPLORATORY), false, 'exploratory cannot certify');
  assert.strictEqual(canCertify(MODE.CERTIFYING), true, 'certifying can');

  pass('T-2', 'an exploratory run never makes an authoritative product finding');
}

// ---------------------------------------------------------------------------
// T-5  The cause vocabulary is closed, and PRODUCT is the only accusation.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    [...CAUSES].sort(),
    [
      'BINDING_INVALID',
      'CONTRACT_INVALID',
      'EVIDENCE_INVALID',
      'HARNESS_ENVIRONMENT',
      'HARNESS_INTERNAL',
      'PRODUCT',
      'UNKNOWN',
    ],
    'the cause vocabulary must be exactly these seven'
  );

  // Exactly one cause accuses the subject, and so exactly one carries a burden
  // of proof: fed back in with no assertion and no evidence, every other cause
  // survives unchanged. If a second gated cause ever appears, this fails and
  // forces the question of whether it too must be earned.
  const gated = CAUSES.filter((c) => {
    const verdict = attributeFailure(
      { reported: c, hasAcceptedAssertion: false, hasSupportingEvidence: false },
      MODE.CERTIFYING
    );
    return verdict.cause !== c;
  });
  assert.deepStrictEqual(gated, [CAUSE.PRODUCT], 'only PRODUCT must be earned');

  // And UNKNOWN is a stable resting state: it maps to itself, so a verdict
  // cannot be laundered into an accusation by being re-attributed.
  assert.strictEqual(
    attributeFailure({ reported: CAUSE.UNKNOWN }, MODE.CERTIFYING).cause,
    CAUSE.UNKNOWN,
    'UNKNOWN must stay UNKNOWN'
  );

  pass('T-5', 'the cause vocabulary is closed and only PRODUCT must be earned');
}

console.log(`\n  ${results.length} attribution checks passed\n`);
