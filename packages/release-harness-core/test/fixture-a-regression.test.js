// Fixture A, re-run against the new model.
//
// The self-adoption fixture ran shipped 2.0.0 against this repository and found
// a defect reachable on the documented happy path with zero bypasses:
//
//   `init` wrote a topology asserting a browser app on port 3000. `doctor`
//   reported it valid and printed "Status: Ready" -- in a repository containing
//   no such app. The run then probed the invented port, got a 502, and
//   attributed PRODUCT_BUG to software that had never made the promise.
//
// Nobody had accepted anything. A proposition the tool invented about itself
// was adjudicated and blamed on the product. These tests reproduce each link in
// that chain and prove it now breaks.
//
// This is a regression suite for a specific historical failure, so it is
// written in the fixture's terms rather than the model's -- the value is in
// being able to point at the original report and see each finding answered.

import assert from 'node:assert';

import { decideMode, describeReadiness, INELIGIBLE } from '../src/bindings.js';
import { attributeFailure, CAUSE, MODE, canCertify } from '../src/attribution.js';
import { acceptDraft } from '../src/acceptance.js';
import { checkAcceptability } from '../src/draft.js';
import { buildRunManifest, verifyRunManifest } from '../src/run-manifest.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nFixture A: the self-adoption defect, re-run\n');

// The fabricated proposition, as `init` produced it: a browser app on port
// 3000, in a repository that runs no server.
const fabricated = {
  schema_version: '1.0.0',
  subject: { id: 'release-harness' },
  assertions: [
    { id: 'A1', kind: 'http', target: 'web', expect: { path: '/', status: 200 } },
  ],
};
const inventedBindings = { targets: { web: 'http://localhost:3000' } };

// ---------------------------------------------------------------------------
// F-1  "Status: Ready" with nothing accepted.
//
// The fixture's decisive observation was that doctor held the evidence and drew
// the opposite conclusion: it enumerated three absent contracts and concluded
// Ready, exit 0. Every individual fact was true. The summary was false, and the
// summary was the only line anyone read.
// ---------------------------------------------------------------------------
{
  const readiness = describeReadiness({ contract: null, bindings: {} });

  // There is no summary to be wrong. A caller wanting one must decide what it
  // is claiming, which is the point -- "ready" is not a property of an
  // installation, it is a claim about a specific intention.
  assert.ok(
    !('ready' in readiness) && !('status' in readiness) && !('ok' in readiness),
    'no aggregate flag may exist for a caller to read instead of the facts'
  );

  assert.strictEqual(readiness.contract_present, false, 'the absence of a contract is a stated fact');
  assert.strictEqual(readiness.certification_eligible, false, 'and eligibility is its own fact');
  assert.ok(
    readiness.reasons.some((r) => r.code === INELIGIBLE.NO_CONTRACT),
    'with a reason an operator can act on'
  );

  pass('F-1', 'nothing accepted can no longer report as ready');
}

// ---------------------------------------------------------------------------
// F-2  A fabricated proposition cannot be certified.
//
// The fixture's sharpest finding: validity was structural only. A topology
// asserting an app that does not exist was reported *valid*, because nothing
// checked whether anyone had agreed to it.
//
// The fix is not better validation -- a tool cannot tell a true proposition
// from a false one by inspection. The fix is that an unaccepted proposition
// cannot certify, whether it is true or not.
// ---------------------------------------------------------------------------
{
  const decision = decideMode(fabricated, inventedBindings);

  assert.strictEqual(
    decision.mode,
    MODE.EXPLORATORY,
    'a proposition nobody accepted cannot be certified, however well-formed'
  );
  assert.ok(
    decision.reasons.some((r) => r.code === INELIGIBLE.CONTRACT_NOT_ACCEPTED),
    'and the reason must be its unaccepted status, not its shape'
  );
  assert.strictEqual(canCertify(decision.mode), false, 'so this run cannot certify');

  pass('F-2', 'a fabricated proposition cannot be certified, however well-formed');
}

// ---------------------------------------------------------------------------
// F-3  The decisive result: no PRODUCT_BUG for an invented port.
//
// 2.0.0 probed a port it had invented, got a 502, and attributed PRODUCT_BUG.
// Two independent barriers now stop that, and both are tested, because either
// one alone would be a single point of failure for the invariant that matters
// most.
// ---------------------------------------------------------------------------
{
  // Barrier one: the run is exploratory, so no authoritative product finding is
  // possible at all -- nothing was accepted, so there is no promise to break.
  const exploratory = attributeFailure(
    { reported: CAUSE.PRODUCT, hasAcceptedAssertion: true, hasSupportingEvidence: true },
    MODE.EXPLORATORY
  );
  assert.strictEqual(exploratory.cause, CAUSE.UNKNOWN, 'an exploratory run makes no product finding');
  assert.strictEqual(exploratory.authoritative, false, 'and nothing it says is authoritative');

  // Barrier two: even in a certifying run, a 502 against an unreachable port
  // carries no accepted assertion, so the burden of proof is not met.
  const certifying = attributeFailure(
    { reported: CAUSE.PRODUCT, hasAcceptedAssertion: false, hasSupportingEvidence: false },
    MODE.CERTIFYING
  );
  assert.strictEqual(certifying.cause, CAUSE.UNKNOWN, 'product attribution must be earned');

  // And the original defect directly: the probe reported nothing, because there
  // was nothing to report. Silence used to mean PRODUCT_BUG.
  const silent = attributeFailure({ reported: 'NONE' }, MODE.CERTIFYING);
  assert.strictEqual(silent.cause, CAUSE.UNKNOWN, 'silence is not evidence against the product');
  assert.notStrictEqual(silent.cause, CAUSE.PRODUCT, 'the 2.0.0 default is gone');

  // What the failure actually was: nothing listening where the harness was told
  // to look. That is a binding problem, and it sends the right person looking.
  const honest = attributeFailure({ reported: CAUSE.BINDING_INVALID }, MODE.CERTIFYING);
  assert.strictEqual(honest.cause, CAUSE.BINDING_INVALID, 'an unreachable target is a binding fault');
  assert.strictEqual(honest.authoritative, true, 'which accuses nobody and needs no proof');

  pass('F-3', 'an invented port can no longer produce a product bug');
}

// ---------------------------------------------------------------------------
// F-4  An exploratory run produces nothing confusable with a certificate.
//
// The fixture found the run-level UNPROVEN was not a guard -- it was the
// --allow-dirty downgrade, and on a clean tree the same run yielded FAIL with
// PRODUCT_BUG operative. So the artifact itself must be unambiguous.
// ---------------------------------------------------------------------------
{
  const decision = decideMode(fabricated, inventedBindings);
  const verdict = { status: 'FAIL', assertions: [{ id: 'A1', status: 'FAIL', cause: CAUSE.UNKNOWN }] };

  const manifest = buildRunManifest({
    runId: 'fixture-a',
    contract: null,
    bindings: inventedBindings,
    evidenceManifestSha256: '0'.repeat(64),
    verdict,
    mode: decision.mode,
    ineligibleReasons: decision.reasons,
  });

  assert.strictEqual(manifest.contract, null, 'the manifest cites no contract, because there is none');
  assert.strictEqual(manifest.certification.eligible, false, 'and is marked ineligible on its face');
  assert.ok(
    manifest.certification.ineligible_reasons.length > 0,
    'with the reasons retained for whoever reads it later'
  );

  // Forging the claim afterwards does not work: a manifest asserting
  // eligibility while citing no contract is rejected outright, which is exactly
  // the shape a fabricated certificate would take.
  const forged = { ...manifest, certification: { mode: MODE.CERTIFYING, eligible: true } };
  assert.ok(
    verifyRunManifest(forged, {}).broken.some((b) => b.link === 'certification'),
    'a certificate citing no contract must be rejected'
  );

  pass('F-4', 'an exploratory run cannot produce or be edited into a certificate');
}

// ---------------------------------------------------------------------------
// F-5  The honest path this repository should have taken.
//
// The fixture's report asked what a newcomer was supposed to do instead. This
// is the answer, and it has to be walkable -- a rule that blocks the wrong path
// without opening a right one just moves the problem.
// ---------------------------------------------------------------------------
{
  // A tool may propose. What it may not do is pretend its proposal was checked:
  // the claim it was built from is an inference, and it says so.
  const proposed = {
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 'release-harness' },
      assertions: [{ id: 'A1', kind: 'http', target: 'web', expect: { status: 200 }, supported_by: ['guess'] }],
    },
    questions: [
      { id: 'Q1', question: 'Does this project serve HTTP at all?', blocking: true },
    ],
  };
  const proposedRecord = {
    schema_version: '1.0.0',
    authored_by: 'init',
    claims: [
      {
        id: 'guess',
        claim: 'the project serves a browser app on port 3000',
        status: 'inferred',
        evidence: { source: 'scaffold default' },
      },
    ],
  };

  const refused = checkAcceptability(proposed, proposedRecord);
  assert.strictEqual(refused.acceptable, false, 'a scaffolded guess cannot be accepted as-is');
  assert.ok(
    refused.blockers.some((b) => b.kind === 'unsupported_claim'),
    'because an inference cannot support an accepted assertion'
  );
  assert.ok(
    refused.blockers.some((b) => b.kind === 'unresolved_question'),
    'and the question it could not answer is still open'
  );

  // The operator answers the question honestly: this project ships a CLI, not a
  // browser app. The corrected proposition is accepted and certifies.
  const corrected = {
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 'release-harness', name: 'release-harness' },
      assertions: [
        {
          id: 'A1',
          kind: 'cli',
          target: 'cli',
          description: 'the CLI reports its version',
          expect: { command: 'release-harness --version', exit_code: 0 },
          supported_by: ['cli-entrypoint'],
        },
      ],
    },
    questions: [
      {
        id: 'Q1',
        question: 'Does this project serve HTTP at all?',
        blocking: true,
        resolution: 'No. It is a CLI and a library; there is no server.',
        resolved_by: 'a.operator',
      },
    ],
  };
  const correctedRecord = {
    schema_version: '1.0.0',
    authored_by: 'a.operator',
    claims: [
      {
        id: 'cli-entrypoint',
        claim: 'bin/release-harness.js is the published entrypoint',
        status: 'observed',
        evidence: { source: 'package.json#bin' },
      },
    ],
  };

  const contract = acceptDraft(corrected, correctedRecord, { by: 'a.operator' });
  const decision = decideMode(contract, { targets: { cli: 'node bin/release-harness.js' } });

  assert.strictEqual(decision.mode, MODE.CERTIFYING, 'an accepted, bound contract certifies');
  assert.deepStrictEqual(decision.reasons, [], 'with nothing in the way');

  pass('F-5', 'the honest path is open: propose, ask, correct, accept, certify');
}

console.log(`\n  ${results.length} Fixture A findings answered\n`);
