// Negative-evidence semantics: what it takes to claim something is absent.
//
// These are the highest-value tests in the suite, because they encode the
// highest-recurrence defect the research found: five absence errors from three
// careful actors, every one the same shape -- a search ran, nothing came back,
// and "nothing came back" was recorded as "it does not exist."
//
// The two statements differ. Finding a file proves it exists; failing to find
// one proves nothing unless you know where you looked and whether you finished.
// So these tests do not check that the rule is documented. They check that a
// caller who has never read it cannot get it wrong.

import assert from 'node:assert';
import Ajv from 'ajv';
import { Schemas } from '../../release-harness-schemas/index.js';
import {
  classifySearch,
  checkClaim,
  checkAuthoringRecord,
  checkDraft,
  checkAcceptability,
  correctWithObservation,
  supportsClaim,
  EPISTEMIC_STATUSES,
} from '../src/draft.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nNegative-evidence and draft semantics\n');

// ---------------------------------------------------------------------------
// E-1  A completed search that finds nothing establishes absence.
// ---------------------------------------------------------------------------
{
  const status = classifySearch({
    completed: true,
    found: false,
    method: 'git ls-files',
    roots: ['.'],
  });
  assert.strictEqual(status, 'observed_absent', 'a completed search that found nothing is absence');
  assert.ok(supportsClaim('observed_absent'), 'bounded absence must support a claim');

  const claim = {
    id: 'no-compose',
    claim: 'the repository contains no docker-compose file',
    status: 'observed_absent',
    evidence: {
      method: 'git ls-files "**/docker-compose*.y*ml"',
      roots: ['.'],
      exclusions: ['node_modules'],
      completed: true,
    },
  };
  assert.deepStrictEqual(checkClaim(claim, 0), [], 'a bounded, completed absence claim is valid');

  pass('E-1', 'a completed bounded search establishes absence');
}

// ---------------------------------------------------------------------------
// E-2  A search that did not complete establishes NOTHING.
//
// This is the defect itself. A killed, timed-out or truncated search must not
// be able to produce a claim of absence -- not at low confidence, not with a
// caveat. The research recorded four separate occasions where a recursive scan
// was killed and its silence read as a finding.
// ---------------------------------------------------------------------------
{
  for (const reason of ['killed', 'timed out', 'truncated', 'errored']) {
    assert.strictEqual(
      classifySearch({ completed: false, found: false, method: `scan (${reason})` }),
      'not_established',
      `a ${reason} search must establish nothing`
    );
  }
  assert.ok(!supportsClaim('not_established'), 'not_established must support no claim');

  // The rule holds through the validator too: a claim of absence whose evidence
  // does not assert completion is rejected, with the correct status named.
  const truncated = {
    id: 'maybe-no-workflow',
    claim: 'there is no production deploy workflow',
    status: 'observed_absent',
    evidence: { method: 'ls .github/workflows', roots: ['.github/workflows'], completed: false },
  };
  const errs = checkClaim(truncated, 0);
  assert.ok(
    errs.some((e) => /completed must be true/.test(e) && /not_established/.test(e)),
    'an incomplete search claiming absence must be rejected and redirected'
  );

  // And the caller cannot dodge the question by omitting it.
  assert.throws(
    () => classifySearch({ found: false }),
    /explicit `completed` boolean/,
    'completion must be stated, never defaulted'
  );

  pass('E-2', 'an incomplete search establishes nothing and cannot claim absence');
}

// ---------------------------------------------------------------------------
// E-2b  Absence claims must carry their bounds.
//
// "Not found" without a scope is a statement about the search. The validator
// demands method and roots so a reader can judge whether the search was capable
// of finding the thing.
// ---------------------------------------------------------------------------
{
  const unbounded = {
    id: 'no-tests',
    claim: 'the project has no tests',
    status: 'observed_absent',
    evidence: { completed: true },
  };
  const errs = checkClaim(unbounded, 0);
  assert.ok(errs.some((e) => /method/.test(e)), 'an absence claim must say how it searched');
  assert.ok(errs.some((e) => /roots/.test(e)), 'an absence claim must say where it searched');

  // Positive claims are deliberately cheaper: the thing was seen.
  const positive = {
    id: 'has-compose',
    claim: 'the service is defined in compose',
    status: 'observed',
    evidence: { source: 'docker-compose.yml:12' },
  };
  assert.deepStrictEqual(
    checkClaim(positive, 0),
    [],
    'a positive claim needs only its source; asymmetry is intentional'
  );

  pass('E-2b', 'negative claims carry bounds, positive claims do not');
}

// ---------------------------------------------------------------------------
// E-3  A test asserting nonexistence is evidence of a different kind.
//
// The status nobody anticipates. During the research a missing workflow file
// looked like proof that declarations go stale -- until a test was found
// asserting the file must NOT exist. Two independent actors got it backwards by
// using `ls` as a proxy for intent. Absent-by-decision is not the same fact as
// absent-today, and the model must be able to tell them apart.
// ---------------------------------------------------------------------------
{
  const asserted = {
    id: 'no-prod-deploy-workflow',
    claim: 'there is deliberately no production deploy workflow',
    status: 'asserted_absent',
    evidence: { asserted_by: 'tests/test_deploy_workflow_contract.py:11' },
  };
  assert.deepStrictEqual(checkClaim(asserted, 0), [], 'a cited assertion of absence is valid');
  assert.ok(supportsClaim('asserted_absent'), 'asserted absence must support a claim');

  // Without a citation it is an inference wearing a stronger status.
  const uncited = { ...asserted, evidence: {} };
  assert.ok(
    checkClaim(uncited, 0).some((e) => /asserted_by/.test(e) && /inference/.test(e)),
    'an uncited assertion of absence must be rejected as an inference'
  );

  pass('E-3', 'asserted absence is distinct from searched absence and must cite its source');
}

// ---------------------------------------------------------------------------
// E-4  A positive finding corrects a recorded absence, visibly.
//
// I made this error myself during the research: reported a repository had no
// compose file after globbing only its root. It had two, at depth 2. The
// correction must win -- and must remain legible, so the superseded claim is
// retained rather than overwritten.
// ---------------------------------------------------------------------------
{
  const wrong = {
    id: 'no-compose',
    claim: 'the repository contains no compose file',
    status: 'observed_absent',
    evidence: { method: 'glob ./docker-compose.yml', roots: ['.'], completed: true },
  };

  const corrected = correctWithObservation(wrong, {
    source: 'deploy/local/docker-compose.yml',
    reason: 'the earlier glob searched only the repository root',
  });

  assert.strictEqual(corrected.status, 'observed', 'a direct observation wins over a failed search');
  assert.strictEqual(
    corrected.superseded.status,
    'observed_absent',
    'the corrected claim must retain what it replaced'
  );
  assert.match(
    corrected.superseded.reason,
    /root/,
    'the correction must record why the earlier search was wrong'
  );
  assert.strictEqual(wrong.status, 'observed_absent', 'correction must not mutate its input');
  assert.deepStrictEqual(checkClaim(corrected, 0), [], 'a corrected claim must itself be valid');

  pass('E-4', 'a positive finding corrects an absence and the correction stays legible');
}

// ---------------------------------------------------------------------------
// E-5  Acceptance refuses to rest an assertion on an unestablished claim.
//
// A draft may hold inferences and open questions -- that is what drafting is.
// Acceptance is where someone takes responsibility, so the evidence underneath
// must hold. Every blocker is returned, not just the first.
// ---------------------------------------------------------------------------
{
  const draft = {
    proposition: {
      subject: { id: 'checkout-service' },
      assertions: [
        { id: 'A1', kind: 'http', target: 'api', supported_by: ['port-claim'] },
        { id: 'A2', kind: 'http', target: 'web', supported_by: ['guessed-route'] },
        { id: 'A3', kind: 'http', target: 'api', supported_by: ['never-checked'] },
      ],
    },
    questions: [
      { id: 'Q1', question: 'Is the health path /health or /healthz?', blocking: true },
    ],
  };

  const record = {
    claims: [
      {
        id: 'port-claim',
        claim: 'the api listens on 3000',
        status: 'observed',
        evidence: { source: 'docker-compose.yml:14' },
      },
      {
        id: 'guessed-route',
        claim: 'the web app serves /dashboard',
        status: 'inferred',
        evidence: { source: 'router naming convention' },
      },
      {
        id: 'never-checked',
        claim: 'there is no rate limiter',
        status: 'not_established',
      },
    ],
  };

  const { acceptable, blockers } = checkAcceptability(draft, record);
  assert.strictEqual(acceptable, false, 'a draft resting on inference must not be acceptable');

  assert.ok(
    blockers.some((b) => b.kind === 'unsupported_claim' && /A2/.test(b.detail)),
    'an assertion resting on an inference must be blocked'
  );
  assert.ok(
    blockers.some((b) => b.kind === 'unsupported_claim' && /A3/.test(b.detail)),
    'an assertion resting on an unestablished claim must be blocked'
  );
  assert.ok(
    blockers.some((b) => b.kind === 'unresolved_question' && /Q1/.test(b.detail)),
    'an unresolved blocking question must be reported'
  );
  assert.ok(
    !blockers.some((b) => /A1/.test(b.detail)),
    'an assertion resting on an observation must not be blocked'
  );
  assert.ok(blockers.length >= 3, 'every blocker must be returned, not just the first');

  // A cited claim that does not exist is its own failure: an assertion whose
  // support cannot be found is unsupported, not assumed-fine.
  const dangling = {
    proposition: {
      subject: { id: 's' },
      assertions: [{ id: 'A1', kind: 'http', target: 'api', supported_by: ['nope'] }],
    },
  };
  assert.ok(
    checkAcceptability(dangling, { claims: [] }).blockers.some((b) => b.kind === 'missing_claim'),
    'an assertion citing a nonexistent claim must be blocked'
  );

  pass('E-5', 'acceptance refuses assertions resting on inference or on nothing');
}

// ---------------------------------------------------------------------------
// E-6  A resolved draft with sound evidence becomes acceptable.
//
// The rules must be satisfiable, or authors will route around them. Note that
// an unresolved NON-blocking question and an unused `not_established` claim both
// remain -- recorded uncertainty is not an obstacle to acceptance, or authors
// would learn to delete uncertainties rather than write them down.
// ---------------------------------------------------------------------------
{
  const draft = {
    proposition: {
      subject: { id: 'checkout-service' },
      assertions: [
        { id: 'A1', kind: 'http', target: 'api', supported_by: ['port-claim'] },
        { id: 'A2', kind: 'http', target: 'api', supported_by: ['no-legacy-endpoint'] },
        { id: 'A3', kind: 'http', target: 'api', supported_by: ['no-prod-workflow'] },
      ],
    },
    questions: [
      { id: 'Q1', question: 'Health path?', blocking: true, resolution: '/health, per the router' },
      { id: 'Q2', question: 'Should we assert the 404 body?', blocking: false },
    ],
  };

  const record = {
    claims: [
      {
        id: 'port-claim',
        claim: 'the api listens on 3000',
        status: 'observed',
        evidence: { source: 'docker-compose.yml:14' },
      },
      {
        id: 'no-legacy-endpoint',
        claim: 'no /v1 endpoints remain',
        status: 'observed_absent',
        evidence: {
          method: 'git grep -n "\'/v1"',
          roots: ['src', 'routes'],
          exclusions: ['node_modules'],
          completed: true,
        },
      },
      {
        id: 'no-prod-workflow',
        claim: 'production deploys deliberately have no workflow file',
        status: 'asserted_absent',
        evidence: { asserted_by: 'tests/test_deploy_workflow_contract.py:11' },
      },
      {
        id: 'unused-unknown',
        claim: 'rate limiting behaviour under burst is unknown',
        status: 'not_established',
      },
    ],
  };

  assert.deepStrictEqual(checkAuthoringRecord(record), [], 'the record must be valid');
  assert.deepStrictEqual(checkDraft(draft), [], 'the draft must be valid');

  const { acceptable, blockers } = checkAcceptability(draft, record);
  assert.deepStrictEqual(blockers, [], 'a sound draft must have no blockers');
  assert.strictEqual(acceptable, true, 'a resolved, evidenced draft must be acceptable');

  pass('E-6', 'a resolved draft with sound evidence is acceptable; recorded unknowns are not blockers');
}

// ---------------------------------------------------------------------------
// E-7  The status vocabulary is closed and duplicate claims are caught.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    [...EPISTEMIC_STATUSES].sort(),
    ['asserted_absent', 'inferred', 'not_established', 'observed', 'observed_absent'],
    'the epistemic vocabulary must be exactly these five statuses'
  );

  const invented = { id: 'c', claim: 'x', status: 'probably', evidence: {} };
  assert.ok(
    checkClaim(invented, 0).some((e) => /status must be one of/.test(e)),
    'an invented status must be rejected rather than treated as unknown'
  );

  const dup = {
    claims: [
      { id: 'same', claim: 'a', status: 'observed', evidence: { source: 'f' } },
      { id: 'same', claim: 'b', status: 'observed', evidence: { source: 'g' } },
    ],
  };
  assert.ok(
    checkAuthoringRecord(dup).some((e) => /Duplicate claim id/.test(e)),
    'duplicate claim ids must be rejected -- assertions cite claims by id'
  );

  pass('E-7', 'the status vocabulary is closed and claim ids are unique');
}

// ---------------------------------------------------------------------------
// E-8  The schema enforces the absence rule on its own.
//
// The runtime checks and the schema are two authorities over one artifact. If
// only the runtime enforced the completion rule, a record written by any other
// tool -- or loaded past the runtime path -- could carry an unbounded absence
// claim. So the rule is tested through the schema directly, with the runtime
// deliberately not in the picture.
// ---------------------------------------------------------------------------
{
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateRecord = ajv.compile(Schemas.AuthoringRecordV1);
  const validateDraft = ajv.compile(Schemas.DraftV1);

  const record = (claim) => ({ schema_version: '1.0.0', claims: [claim] });

  const mustReject = [
    [
      'an absence whose search did not complete',
      { id: 'a', claim: 'x', status: 'observed_absent', evidence: { method: 'm', roots: ['.'], completed: false } },
    ],
    [
      'an absence that never says whether it completed',
      { id: 'a', claim: 'x', status: 'observed_absent', evidence: { method: 'm', roots: ['.'] } },
    ],
    [
      'an absence with no roots',
      { id: 'a', claim: 'x', status: 'observed_absent', evidence: { method: 'm', completed: true } },
    ],
    [
      'an absence searching nowhere',
      { id: 'a', claim: 'x', status: 'observed_absent', evidence: { method: 'm', roots: [], completed: true } },
    ],
    [
      'an absence with no evidence at all',
      { id: 'a', claim: 'x', status: 'observed_absent' },
    ],
    [
      'an uncited assertion of absence',
      { id: 'a', claim: 'x', status: 'asserted_absent', evidence: {} },
    ],
    ['an observation citing nothing', { id: 'a', claim: 'x', status: 'observed', evidence: {} }],
    ['an invented status', { id: 'a', claim: 'x', status: 'probably' }],
  ];

  for (const [name, claim] of mustReject) {
    assert.strictEqual(
      validateRecord(record(claim)),
      false,
      `the schema must reject ${name}`
    );
  }

  const mustAccept = [
    [
      'a completed bounded absence',
      { id: 'a', claim: 'x', status: 'observed_absent', evidence: { method: 'git ls-files', roots: ['.'], completed: true } },
    ],
    [
      'a cited assertion of absence',
      { id: 'a', claim: 'x', status: 'asserted_absent', evidence: { asserted_by: 'test.py:11' } },
    ],
    ['a bare unknown', { id: 'a', claim: 'x', status: 'not_established' }],
  ];

  for (const [name, claim] of mustAccept) {
    assert.strictEqual(validateRecord(record(claim)), true, `the schema must accept ${name}`);
  }

  // A draft is allowed to be incomplete -- assertions without a kind or target
  // are how drafting starts. Validating a draft as if it were a contract would
  // force an author to fake completeness before they have it.
  assert.ok(
    validateDraft({
      schema_version: '1.0.0',
      proposition: { subject: { id: 's' }, assertions: [{ id: 'A1' }] },
      questions: [{ id: 'Q1', question: 'which port?', blocking: true }],
    }),
    'a genuinely incomplete draft must still be a valid draft'
  );

  pass('E-8', 'the schema enforces bounded absence without the runtime');
}

console.log(`\n  ${results.length} negative-evidence checks passed\n`);
