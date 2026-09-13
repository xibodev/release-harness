// Deterministic adjudication.
//
// The property being protected: the same sealed inputs always produce the same
// verdict, with no CLI-specific interpretation anywhere in the path. The old
// architecture had an evaluator that guaranteed this and it was deleted with
// the scenario model it served -- what is tested here is not that code, but the
// property that made it worth having.
//
// The practical reason this matters: a verdict is hashed into the run manifest
// and checked by `verify`. If adjudication varied by insertion order, clock, or
// caller, the chain would break for runs nobody had tampered with -- and a
// verification failure that fires on honest runs teaches people to ignore it.

import assert from 'node:assert';
import { adjudicate, exitCodeForVerdict } from '../src/adjudicate.js';
import { artifactDigest } from '../src/run-manifest.js';
import { MODE, CAUSE } from '../src/attribution.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nDeterministic adjudication\n');

const contract = {
  digest: 'c'.repeat(64),
  subject: { id: 'svc' },
  assertions: [{ id: 'A1', kind: 'cli', target: 'cli' }, { id: 'A2', kind: 'cli', target: 'cli' }],
};

/** An observation of the subject actually running and misbehaving. */
const productFailure = (id) => ({
  id,
  passed: false,
  cause: CAUSE.PRODUCT,
  observed: 'exit 1, expected 0',
  detail: { subject_reached: true, exit_code: 1 },
});

const passing = (id) => ({ id, passed: true, cause: 'NONE', observed: 'exit 0', detail: { subject_reached: true } });

// ---------------------------------------------------------------------------
// D-1  Identical inputs produce byte-identical verdicts.
// ---------------------------------------------------------------------------
{
  const inputs = {
    runId: 'run-fixed',
    observations: [passing('A1'), productFailure('A2')],
    contract,
    mode: MODE.CERTIFYING,
  };

  const first = adjudicate(inputs);
  const digest = artifactDigest(first);

  for (let i = 0; i < 50; i++) {
    const again = adjudicate(inputs);
    assert.strictEqual(
      artifactDigest(again),
      digest,
      'adjudication must be a pure function of its inputs'
    );
  }

  // Nothing time-dependent may leak in: the verdict is hashed, so a timestamp
  // would make every re-adjudication of the same run look like tampering.
  assert.ok(!JSON.stringify(first).match(/\d{4}-\d{2}-\d{2}T/), 'no timestamp may enter the verdict');

  pass('D-1', 'the same inputs produce a byte-identical verdict, 50 times over');
}

// ---------------------------------------------------------------------------
// D-2  Cause aggregation is order-independent.
//
// Two runs with the same problems must produce the same verdict regardless of
// which assertion happened to fail first.
// ---------------------------------------------------------------------------
{
  const binding = {
    id: 'A1',
    passed: false,
    cause: CAUSE.BINDING_INVALID,
    observed: 'nothing answered',
    detail: { subject_reached: false },
  };
  const product = productFailure('A2');

  const forward = adjudicate({ runId: 'r', observations: [binding, product], contract, mode: MODE.CERTIFYING });
  const backward = adjudicate({ runId: 'r', observations: [product, binding], contract, mode: MODE.CERTIFYING });

  assert.deepStrictEqual(forward.causes, backward.causes, 'aggregated causes must not depend on order');
  assert.deepStrictEqual(forward.causes, ['BINDING_INVALID', 'PRODUCT'], 'and must be stably sorted');
  assert.strictEqual(forward.summary.failed, backward.summary.failed, 'as must the summary');

  pass('D-2', 'cause aggregation is stable and order-independent');
}

// ---------------------------------------------------------------------------
// D-3  Product attribution requires the subject to have been reached.
//
// This is the rule that was living in the CLI. It reads a structural fact the
// adapter recorded -- never output, never an inference.
// ---------------------------------------------------------------------------
{
  const reached = adjudicate({
    runId: 'r',
    observations: [{ ...productFailure('A1'), detail: { subject_reached: true } }],
    contract,
    mode: MODE.CERTIFYING,
  });
  assert.strictEqual(reached.assertions[0].cause, CAUSE.PRODUCT, 'a reached subject may be attributed');

  for (const state of [false, 'not_established', undefined]) {
    const unreached = adjudicate({
      runId: 'r',
      observations: [{ ...productFailure('A1'), detail: { subject_reached: state } }],
      contract,
      mode: MODE.CERTIFYING,
    });
    assert.strictEqual(
      unreached.assertions[0].cause,
      CAUSE.UNKNOWN,
      `subject_reached=${String(state)} must not support a product attribution`
    );
  }

  pass('D-3', 'product attribution reads a structural fact, not an inference');
}

// ---------------------------------------------------------------------------
// D-4  Certification status, integrity and exit code are computed here.
// ---------------------------------------------------------------------------
{
  const clean = adjudicate({ runId: 'r', observations: [passing('A1')], contract, mode: MODE.CERTIFYING });
  assert.strictEqual(clean.status, 'PASS', 'a clean certifying run passes');
  assert.strictEqual(clean.run_integrity, 'COMPLETE', 'with intact machinery');
  assert.strictEqual(exitCodeForVerdict(clean), 0, 'exit 0');

  const broken = adjudicate({ runId: 'r', observations: [productFailure('A1')], contract, mode: MODE.CERTIFYING });
  assert.strictEqual(broken.status, 'FAIL', 'a violated assertion fails');
  assert.strictEqual(exitCodeForVerdict(broken), 1, 'exit 1: the subject broke a promise');

  // An exploratory run that passes everything still cannot certify.
  const explored = adjudicate({ runId: 'r', observations: [passing('A1')], contract: null, mode: MODE.EXPLORATORY });
  assert.strictEqual(explored.status, 'UNPROVEN', 'exploratory never reaches PASS');
  assert.strictEqual(exitCodeForVerdict(explored), 2, 'exit 2: nothing was proven');

  // A run whose evidence did not seal cannot support a conclusion either way,
  // and says so ahead of anything it seemed to observe.
  const unsealed = adjudicate({
    runId: 'r',
    observations: [passing('A1')],
    contract,
    mode: MODE.CERTIFYING,
    evidenceSealed: false,
  });
  assert.strictEqual(unsealed.run_integrity, 'EVIDENCE_INVALID', 'unsealed evidence is an integrity failure');
  assert.strictEqual(exitCodeForVerdict(unsealed), 4, 'exit 4, even though every assertion passed');

  // An environment failure is not a product failure, and must not exit 1.
  const envFailed = adjudicate({
    runId: 'r',
    observations: [
      { id: 'A1', passed: false, cause: CAUSE.HARNESS_ENVIRONMENT, observed: 'timed out', detail: {} },
    ],
    contract,
    mode: MODE.CERTIFYING,
  });
  assert.strictEqual(envFailed.run_integrity, 'HARNESS_ERROR', 'the harness failed, not the subject');
  assert.strictEqual(exitCodeForVerdict(envFailed), 4, 'exit 4, never 1');

  pass('D-4', 'status, integrity and exit code are one decision made in one place');
}

// ---------------------------------------------------------------------------
// D-5  Nothing unattributed can reach exit 1.
//
// The property CI depends on: silence must never be reported as an accusation.
// ---------------------------------------------------------------------------
{
  for (const cause of Object.values(CAUSE)) {
    const v = adjudicate({
      runId: 'r',
      observations: [{ id: 'A1', passed: false, cause, observed: 'x', detail: { subject_reached: true } }],
      contract,
      mode: MODE.CERTIFYING,
    });

    if (cause === CAUSE.PRODUCT) {
      assert.strictEqual(exitCodeForVerdict(v), 1, 'only a substantiated product finding exits 1');
    } else {
      assert.notStrictEqual(
        exitCodeForVerdict(v),
        1,
        `${cause} must never exit 1 -- CI would read it as a product accusation`
      );
    }
  }

  pass('D-5', 'only a substantiated product finding can exit 1');
}

console.log(`\n  ${results.length} determinism checks passed\n`);
