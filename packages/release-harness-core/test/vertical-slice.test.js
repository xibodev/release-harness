// The manual vertical slice: draft -> validate -> accept -> bind -> run -> verify.
//
// This is the gate. The product has to work end to end with no AI involved at
// all, because an agent is a convenience for authoring and must never be load-
// bearing for certification. If a human cannot walk this path with a text
// editor, the product does not exist -- it is a wrapper around a model.
//
// So this file uses no agent, no discovery, no scaffolding. It writes the
// documents by hand, the way an operator would, and walks the lifecycle to a
// verifiable certificate. Every assertion here is about the PRODUCT working,
// not about a unit behaving.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateDraft,
  validateAuthoringRecord,
  validateAcceptedContract,
} from '../src/validator.js';
import { checkAcceptability } from '../src/draft.js';
import { acceptDraft, verifyAcceptedContract } from '../src/acceptance.js';
import { decideMode, resolveBindings, describeReadiness, INELIGIBLE } from '../src/bindings.js';
import { buildRunManifest, verifyRunManifest } from '../src/run-manifest.js';
import { attributeFailure, CAUSE, MODE } from '../src/attribution.js';
import { EvidenceSealer } from '../src/sealer.js';

const results = [];
function step(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nManual vertical slice (no AI in the loop)\n');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(workspace, f), 'utf8'));
const write = (f, o) => {
  const full = path.join(workspace, f);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Written pretty-printed, as a human would. Nothing downstream may depend on
  // this formatting -- that is what canonicalization is for, and the digest
  // computed below proves it.
  fs.writeFileSync(full, JSON.stringify(o, null, 2) + '\n');
};

// ---------------------------------------------------------------------------
// 1. DRAFT -- an operator writes what they believe must hold, and what they
//    could not settle. Both matter: the questions are the honest part.
// ---------------------------------------------------------------------------
{
  write('draft.json', {
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 'checkout-service', name: 'Checkout Service' },
      assertions: [
        {
          id: 'A1',
          kind: 'http',
          target: 'api',
          description: 'the service reports itself healthy',
          expect: { method: 'GET', path: '/health', status: 200 },
          supported_by: ['health-endpoint'],
        },
        {
          id: 'A2',
          kind: 'http',
          target: 'api',
          description: 'the retired v1 API is gone',
          expect: { method: 'GET', path: '/v1/orders', status: 404 },
          supported_by: ['v1-removed'],
        },
      ],
    },
    questions: [
      {
        id: 'Q1',
        question: 'Does /health check the database, or only the process?',
        blocking: true,
      },
      {
        id: 'Q2',
        question: 'Should we assert the response body as well as the status?',
        blocking: false,
      },
    ],
  });

  write('authoring-record.json', {
    schema_version: '1.0.0',
    authored_by: 'a.operator',
    claims: [
      {
        id: 'health-endpoint',
        claim: 'the service exposes GET /health returning 200',
        status: 'observed',
        evidence: { source: 'src/server.js:41' },
      },
      {
        id: 'v1-removed',
        claim: 'no /v1 routes remain in the service',
        // A negative claim, so it carries the bounds of the search that
        // established it. Without them "not found" is a statement about the
        // search, not the world.
        status: 'observed_absent',
        evidence: {
          method: "git grep -n \"'/v1\"",
          roots: ['src', 'routes'],
          exclusions: ['node_modules', 'dist'],
          completed: true,
        },
      },
      {
        id: 'burst-behaviour',
        claim: 'behaviour under burst load is unknown',
        // Recorded and unused. An operator who is penalised for writing down
        // what they do not know will stop writing it down.
        status: 'not_established',
      },
    ],
  });

  const draft = read('draft.json');
  const record = read('authoring-record.json');

  assert.strictEqual(validateDraft(draft), true, 'the hand-written draft validates');
  assert.strictEqual(validateAuthoringRecord(record), true, 'the hand-written record validates');

  step('S-1', 'an operator writes a draft and an authoring record by hand');
}

// ---------------------------------------------------------------------------
// 2. VALIDATE -- acceptance is refused while a blocking question is open.
//    This is the step that makes acceptance mean something.
// ---------------------------------------------------------------------------
{
  const draft = read('draft.json');
  const record = read('authoring-record.json');

  const before = checkAcceptability(draft, record);
  assert.strictEqual(before.acceptable, false, 'an open blocking question must prevent acceptance');
  assert.ok(
    before.blockers.some((b) => b.kind === 'unresolved_question' && /Q1/.test(b.detail)),
    'and must name which question'
  );
  assert.ok(
    !before.blockers.some((b) => /Q2/.test(b.detail)),
    'while a non-blocking question stays open without obstructing anything'
  );

  step('S-2', 'validation refuses acceptance while a blocking question is open');
}

// ---------------------------------------------------------------------------
// 3. ACCEPT -- the operator answers the question, then takes responsibility.
//    Acceptance emits a new immutable artifact; the draft is left alone.
// ---------------------------------------------------------------------------
{
  const draft = read('draft.json');
  draft.questions[0].resolution = 'Process only; the DB check is a separate assertion.';
  draft.questions[0].resolved_by = 'a.operator';
  write('draft.json', draft);

  const record = read('authoring-record.json');
  const contract = acceptDraft(draft, record, {
    by: 'a.operator',
    at: '2026-09-11T10:00:00Z',
    note: 'Accepted for the 2.0 release gate.',
  });
  write('contract.json', contract);

  assert.strictEqual(validateAcceptedContract(read('contract.json')), true, 'the contract validates');
  assert.ok(fs.existsSync(path.join(workspace, 'draft.json')), 'the draft survives acceptance');
  assert.strictEqual(
    read('draft.json').proposition.assertions[0].supported_by[0],
    'health-endpoint',
    'and keeps its authoring scaffolding, which the contract does not'
  );
  assert.strictEqual(
    read('contract.json').assertions[0].supported_by,
    undefined,
    'the contract carries the proposition, not how it was researched'
  );

  // The digest is reproducible from the file on disk, despite it having been
  // written pretty-printed by hand.
  assert.strictEqual(
    verifyAcceptedContract(read('contract.json')).ok,
    true,
    'the digest survives the round trip through a human-formatted file'
  );

  step('S-3', 'acceptance emits an immutable contract and leaves the draft intact');
}

// ---------------------------------------------------------------------------
// 4. BIND -- the operator says where to go and look. This is where the
//    proposition meets a machine, and it is deliberately a separate file.
// ---------------------------------------------------------------------------
{
  write('bindings.local.json', {
    schema_version: '1.0.0',
    targets: { api: 'http://127.0.0.1:3000' },
  });
  write('bindings.ci.json', {
    schema_version: '1.0.0',
    targets: { api: 'https://staging.example.com' },
  });

  const contract = read('contract.json');
  const local = resolveBindings(contract, read('bindings.local.json'));
  assert.strictEqual(local.ok, true, 'the local binding set resolves every target');

  // The same accepted contract, two environments, one identity. This is the
  // property that lets something authored on a laptop be certified in CI.
  const readiness = ['bindings.local.json', 'bindings.ci.json'].map((f) =>
    describeReadiness({ contract, bindings: read(f) })
  );
  assert.ok(
    readiness.every((r) => r.certification_eligible),
    'the contract is certifiable in both environments'
  );

  // An incomplete binding set blocks certification rather than silently
  // skipping the assertion it cannot exercise.
  const unbound = describeReadiness({ contract, bindings: { targets: {} } });
  assert.strictEqual(unbound.certification_eligible, false, 'an unbound target blocks certification');
  assert.ok(
    unbound.reasons.some((r) => r.code === INELIGIBLE.BINDINGS_UNRESOLVED),
    'and says so explicitly'
  );

  step('S-4', 'bindings resolve the contract into two environments without changing it');
}

// ---------------------------------------------------------------------------
// 5. RUN -- mode is decided BEFORE anything executes, evidence is written and
//    sealed, and the failure that occurs is attributed honestly.
// ---------------------------------------------------------------------------
{
  const contract = read('contract.json');
  const bindings = read('bindings.local.json');

  // The gate comes first. Nothing has been materialized, no process started,
  // nothing sealed -- the decision needs none of that, and deferring it is how
  // a run ends up certifying something it was not entitled to.
  const decision = decideMode(contract, bindings);
  assert.strictEqual(decision.mode, MODE.CERTIFYING, 'this run is entitled to certify');

  const evidenceDir = path.join(workspace, 'evidence');
  const sealer = new EvidenceSealer(evidenceDir, 'run-slice-1');

  // A1 passes. A2 fails: the retired endpoint answered 200 instead of 404 --
  // a real violation of an accepted assertion, with evidence behind it.
  sealer.writeEvidence(
    'probes/A1.json',
    JSON.stringify({ assertion: 'A1', status: 200, ok: true }) + '\n'
  );
  sealer.writeEvidence(
    'probes/A2.json',
    JSON.stringify({ assertion: 'A2', status: 200, expected: 404, ok: false }) + '\n'
  );
  const sealed = sealer.sealEvidence();

  const a2 = attributeFailure(
    { reported: CAUSE.PRODUCT, hasAcceptedAssertion: true, hasSupportingEvidence: true },
    decision.mode
  );
  assert.strictEqual(a2.cause, CAUSE.PRODUCT, 'an evidenced violation is attributed to the product');
  assert.strictEqual(a2.authoritative, true, 'authoritatively, because the run was entitled to');

  const verdict = {
    schema_version: '1.0.0',
    run_id: 'run-slice-1',
    status: 'FAIL',
    assertions: [
      { id: 'A1', status: 'PASS' },
      { id: 'A2', status: 'FAIL', cause: a2.cause, rationale: a2.rationale },
    ],
  };
  write('verdict.json', verdict);

  const manifest = buildRunManifest({
    runId: 'run-slice-1',
    contract,
    bindings,
    sources: { 'checkout-service': 'git:9f1c2ab' },
    evidenceManifestSha256: sealed.manifestSha256,
    verdict,
    mode: decision.mode,
    startedAt: '2026-09-11T10:05:00Z',
    completedAt: '2026-09-11T10:05:12Z',
  });
  write('run-manifest.json', manifest);

  step('S-5', 'the run gates first, seals evidence, and attributes its failure honestly');
}

// ---------------------------------------------------------------------------
// 6. VERIFY -- a third party, holding only these files, checks the whole chain.
//    This is the payoff: the artifacts stand on their own.
// ---------------------------------------------------------------------------
{
  const contract = read('contract.json');
  const verdict = read('verdict.json');
  const manifest = read('run-manifest.json');
  const sealer = new EvidenceSealer(path.join(workspace, 'evidence'), 'run-slice-1');

  const chain = verifyRunManifest(manifest, { contract, verdict, sealer });
  assert.strictEqual(chain.ok, true, 'the chain verifies from the files alone');
  assert.deepStrictEqual(
    [...chain.checked].sort(),
    ['contract', 'evidence', 'verdict'],
    'and every link was actually checked, not assumed'
  );
  assert.deepStrictEqual(chain.unchecked, [], 'with nothing left unverified');

  // The manifest keeps the proposition and the environment apart, so a reader
  // can answer "what was promised" and "where was it tested" separately.
  assert.strictEqual(manifest.contract.digest, contract.digest, 'the manifest cites the contract');
  assert.strictEqual(
    manifest.bindings.targets.api,
    'http://127.0.0.1:3000',
    'and records where it looked, without that touching the contract digest'
  );
  assert.strictEqual(manifest.certification.eligible, true, 'the run is legible as a certifying one');

  step('S-6', 'a third party verifies the whole chain from the files alone');
}

// ---------------------------------------------------------------------------
// 7. TAMPER -- the reason any of this exists. Relaxing the failed assertion
//    after the fact must not produce a passing certificate.
// ---------------------------------------------------------------------------
{
  const manifest = read('run-manifest.json');
  const sealer = new EvidenceSealer(path.join(workspace, 'evidence'), 'run-slice-1');

  // Someone edits the contract so the failure becomes a pass.
  const relaxed = read('contract.json');
  relaxed.assertions[1].expect.status = 200;
  assert.strictEqual(
    verifyAcceptedContract(relaxed).ok,
    false,
    'the edited contract no longer matches its own digest'
  );
  assert.ok(
    verifyRunManifest(manifest, { contract: relaxed, verdict: read('verdict.json'), sealer }).broken.some(
      (b) => b.link === 'contract'
    ),
    'and the run manifest refuses it'
  );

  // Someone edits the verdict instead.
  const passing = { ...read('verdict.json'), status: 'PASS' };
  assert.ok(
    verifyRunManifest(manifest, { contract: read('contract.json'), verdict: passing, sealer }).broken.some(
      (b) => b.link === 'verdict'
    ),
    'an edited verdict is detected'
  );

  // Someone edits the evidence.
  fs.writeFileSync(
    path.join(workspace, 'evidence', 'probes', 'A2.json'),
    JSON.stringify({ assertion: 'A2', status: 404, expected: 404, ok: true }) + '\n'
  );
  assert.ok(
    verifyRunManifest(manifest, { contract: read('contract.json'), verdict: read('verdict.json'), sealer }).broken.some(
      (b) => b.link === 'evidence'
    ),
    'mutated evidence is detected'
  );

  step('S-7', 'tampering at any link is detected, so a failure cannot become a certificate');
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(`\n  ${results.length} lifecycle steps passed -- no AI involved\n`);
