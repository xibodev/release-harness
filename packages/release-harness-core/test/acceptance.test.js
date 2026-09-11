// Acceptance: emitting a contract, not flagging a draft.
//
// The property under test is that acceptance produces a NEW immutable artifact
// rather than marking a mutable one. `accepted: true` in an editable file is a
// flag -- anyone can set it, anyone can edit the file afterwards, and nothing
// notices when the accepted thing and the current thing diverge. An artifact
// whose identity is its digest cannot drift without becoming a different
// artifact, and these tests hold that line.

import assert from 'node:assert';
import {
  acceptDraft,
  verifyAcceptedContract,
  AcceptanceRefused,
} from '../src/acceptance.js';
import { contractDigest } from '../src/contract.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nAcceptance semantics\n');

const soundDraft = () => ({
  schema_version: '1.0.0',
  proposition: {
    subject: { id: 'checkout-service', name: 'Checkout Service' },
    assertions: [
      {
        id: 'A1',
        kind: 'http',
        target: 'api',
        expect: { status: 200, path: '/health' },
        supported_by: ['port-claim'],
      },
    ],
  },
  questions: [{ id: 'Q1', question: 'Health path?', blocking: true, resolution: '/health' }],
});

const soundRecord = () => ({
  schema_version: '1.0.0',
  claims: [
    {
      id: 'port-claim',
      claim: 'the api serves /health on 3000',
      status: 'observed',
      evidence: { source: 'docker-compose.yml:14' },
    },
  ],
});

const by = { by: 'a.operator', at: '2026-09-11T09:00:00Z' };

// ---------------------------------------------------------------------------
// A-1  Acceptance emits a new artifact and leaves the draft alone.
// ---------------------------------------------------------------------------
{
  const draft = soundDraft();
  const before = JSON.stringify(draft);

  const contract = acceptDraft(draft, soundRecord(), by);

  assert.strictEqual(JSON.stringify(draft), before, 'acceptance must not mutate the draft');
  assert.match(contract.digest, /^[0-9a-f]{64}$/, 'the emitted contract carries its digest');
  assert.strictEqual(contract.accepted.by, 'a.operator', 'acceptance is attributed');
  assert.strictEqual(contract.accepted.at, '2026-09-11T09:00:00Z', 'acceptance is timestamped');
  assert.strictEqual(
    contract.subject.id,
    'checkout-service',
    'the proposition survives into the contract'
  );

  pass('A-1', 'acceptance emits a contract and leaves the draft untouched');
}

// ---------------------------------------------------------------------------
// A-2  The emitted digest is independently reproducible.
//
// A digest computed over the whole artifact would cover its own envelope, and
// could not be recomputed by a holder without knowing how the envelope was
// built -- unverifiable exactly when verification matters.
// ---------------------------------------------------------------------------
{
  const contract = acceptDraft(soundDraft(), soundRecord(), by);

  assert.strictEqual(
    contractDigest(contract),
    contract.digest,
    'a holder must be able to recompute the digest from the contract alone'
  );
  assert.strictEqual(
    verifyAcceptedContract(contract).ok,
    true,
    'a freshly accepted contract must verify'
  );

  // Accepting the same proposition twice, by different people on different
  // days, must yield one identity. A promise is not a new promise because
  // someone else signed off on it.
  const second = acceptDraft(soundDraft(), soundRecord(), {
    by: 'other.operator',
    at: '2027-01-01T00:00:00Z',
    note: 'reaffirmed after the audit',
  });
  assert.strictEqual(
    second.digest,
    contract.digest,
    'who accepted and when must not change proposition identity'
  );
  assert.notStrictEqual(second.accepted.by, contract.accepted.by, 'but attribution is recorded');

  pass('A-2', 'the digest is reproducible and independent of who accepted it');
}

// ---------------------------------------------------------------------------
// A-3  Editing an accepted contract is detected.
//
// This is what the artifact is for. Relaxing an expectation after acceptance
// must break the digest, so every downstream artifact citing the old one is
// visibly citing something else.
// ---------------------------------------------------------------------------
{
  const contract = acceptDraft(soundDraft(), soundRecord(), by);

  const relaxed = JSON.parse(JSON.stringify(contract));
  relaxed.assertions[0].expect.status = 500;

  const verdict = verifyAcceptedContract(relaxed);
  assert.strictEqual(verdict.ok, false, 'an edited contract must fail verification');
  assert.match(verdict.reason, /edited after acceptance/, 'the failure must name what happened');
  assert.strictEqual(verdict.claimed, contract.digest, 'the claimed digest is reported');
  assert.notStrictEqual(verdict.actual, verdict.claimed, 'the actual digest differs');

  // Adding an assertion is the same class of tampering.
  const widened = JSON.parse(JSON.stringify(contract));
  widened.assertions.push({ id: 'A2', kind: 'http', target: 'api' });
  assert.strictEqual(
    verifyAcceptedContract(widened).ok,
    false,
    'an assertion added after acceptance must be detected'
  );

  // But re-attributing is NOT tampering: the envelope is outside identity.
  const reattributed = { ...contract, accepted: { by: 'someone.else', at: '2030-01-01T00:00:00Z' } };
  assert.strictEqual(
    verifyAcceptedContract(reattributed).ok,
    true,
    'envelope changes must not be reported as tampering with the proposition'
  );

  pass('A-3', 'editing the proposition breaks the digest; editing the envelope does not');
}

// ---------------------------------------------------------------------------
// A-4  Acceptance refuses an unsound draft, with every blocker.
// ---------------------------------------------------------------------------
{
  const draft = soundDraft();
  draft.proposition.assertions.push({
    id: 'A2',
    kind: 'http',
    target: 'web',
    supported_by: ['guessed'],
  });
  draft.questions.push({ id: 'Q2', question: 'Which host?', blocking: true });

  const record = soundRecord();
  record.claims.push({
    id: 'guessed',
    claim: 'the web app is on 8080',
    status: 'inferred',
    evidence: { source: 'a hunch' },
  });

  assert.throws(
    () => acceptDraft(draft, record, by),
    (err) => {
      assert.ok(err instanceof AcceptanceRefused, 'refusal must be typed');
      assert.ok(
        err.blockers.some((b) => b.kind === 'unsupported_claim'),
        'an assertion resting on an inference must block acceptance'
      );
      assert.ok(
        err.blockers.some((b) => b.kind === 'unresolved_question'),
        'an unresolved blocking question must block acceptance'
      );
      assert.ok(err.blockers.length >= 2, 'every blocker must be reported at once');
      return true;
    },
    'an unsound draft must be refused'
  );

  pass('A-4', 'acceptance refuses an unsound draft and reports every blocker');
}

// ---------------------------------------------------------------------------
// A-5  Acceptance must be attributed, and a draft that is too thin is refused.
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => acceptDraft(soundDraft(), soundRecord(), {}),
    /name who accepted/,
    'an unattributed acceptance records responsibility without recording who'
  );

  // A draft may legitimately be incomplete -- but a contract may not, and
  // acceptance is the last point at which that can be caught.
  const thin = {
    schema_version: '1.0.0',
    proposition: { subject: { id: 's' }, assertions: [{ id: 'A1' }] },
  };
  assert.throws(
    () => acceptDraft(thin, { schema_version: '1.0.0', claims: [] }, by),
    (err) => {
      assert.ok(
        err.blockers.some((b) => b.kind === 'contract_invalid'),
        'an incomplete assertion must be caught at acceptance, not at run time'
      );
      return true;
    },
    'a draft too incomplete to be a contract must be refused'
  );

  pass('A-5', 'acceptance demands attribution and refuses an incomplete proposition');
}

// ---------------------------------------------------------------------------
// A-6  Authoring scaffolding does not survive into the contract.
//
// `supported_by` links an assertion to the claims it was built from. That is
// authoring history: real, retained in the authoring record, and deliberately
// not part of the proposition -- otherwise how a promise was researched would
// change what the promise says.
// ---------------------------------------------------------------------------
{
  const contract = acceptDraft(soundDraft(), soundRecord(), by);

  assert.strictEqual(
    contract.assertions[0].supported_by,
    undefined,
    'claim references must not survive into the contract'
  );

  // Two drafts that propose the same thing from different research must accept
  // to the same identity.
  const otherResearch = soundDraft();
  otherResearch.proposition.assertions[0].supported_by = ['read-the-code'];
  const otherRecord = {
    schema_version: '1.0.0',
    claims: [
      {
        id: 'read-the-code',
        claim: 'the api serves /health on 3000',
        status: 'observed',
        evidence: { source: 'src/server.js:41' },
      },
    ],
  };

  assert.strictEqual(
    acceptDraft(otherResearch, otherRecord, by).digest,
    contract.digest,
    'how a proposition was researched must not change what it asserts'
  );

  pass('A-6', 'authoring scaffolding stays in the record, not the contract');
}

console.log(`\n  ${results.length} acceptance checks passed\n`);
