// Accepted is not the same as currently certifiable.
//
// This is the distinction C2 nearly cost us. A draft carrying a validly shaped
// normative reference whose referent is not available here can be accepted --
// and that is correct, not a defect. Acceptance means someone deliberately took
// responsibility for THIS proposition being the right question. It does not
// mean the proposition is true, that its dependencies exist today, or that this
// machine can check it.
//
// The temptation is to "harden" acceptance by requiring every reference to
// resolve first. That would collapse two layers we separated on purpose, and
// the cost is concrete: a contract accepted in one environment could not be
// accepted in another that merely lacked a cached artifact, so the digest would
// stop being an identity and start being a property of a filesystem.
//
// The layers, in order:
//
//   draft                 may be incomplete
//   acceptable            semantic decisions deliberately resolved
//   accepted contract     the exact proposition, frozen
//   certifying-ready      accepted + references resolvable + bindings valid
//   certificate           evidence proves the accepted proposition
//
// R5 is the property that proves they are genuinely separate: the SAME accepted
// contract, unmodified, becomes certifiable when its referent later appears.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nAccepted is not certifying-ready\n');

function rh(cwd, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-ready-'));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const writeJson = (rel, v) =>
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(v, null, 2) + '\n');

const UPSTREAM = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// R1  An agent-invented reference does not reach acceptance.
//
// Case B from the adjudication: a reference proposed without evidence is a
// fabricated semantic decision, and the existing claim machinery already blocks
// it -- no special provenance field for references is needed.
// ---------------------------------------------------------------------------
{
  rh(dir, ['init']);
  rh(dir, ['draft', 'new', 'invented']);

  const draft = readJson('.release-harness/drafts/invented.draft.json');
  draft.proposition.subject = { id: 'svc' };
  draft.proposition.assertions = [
    { id: 'A1', kind: 'cli', target: 'cli', expect: { exit_code: 0 }, supported_by: ['guess'] },
  ];
  draft.proposition.requires = [{ ref: 'upstream', digest: UPSTREAM }];
  draft.questions = [];
  writeJson('.release-harness/drafts/invented.draft.json', draft);

  const record = readJson('.release-harness/drafts/invented.record.json');
  record.claims = [
    {
      id: 'guess',
      claim: 'the upstream schema is the one we depend on',
      status: 'inferred',
      evidence: { source: 'it seemed likely' },
    },
  ];
  writeJson('.release-harness/drafts/invented.record.json', record);

  const accept = rh(dir, ['accept', '--draft', 'invented', '--by', 'operator']);
  assert.notStrictEqual(accept.code, 0, 'a proposition resting on an inference must not be accepted');
  assert.match(accept.all, /inferred|unsupported/i, 'and the reason must be the inference');

  pass('R1', 'a reference resting on an inference is blocked by existing authoring semantics');
}

// ---------------------------------------------------------------------------
// R2  An operator may accept a reference whose referent is unavailable.
// ---------------------------------------------------------------------------
let acceptedDigest;
{
  rh(dir, ['draft', 'new', 'pinned']);

  const draft = readJson('.release-harness/drafts/pinned.draft.json');
  draft.proposition.subject = { id: 'svc' };
  draft.proposition.assertions = [
    { id: 'A1', kind: 'cli', target: 'cli', expect: { exit_code: 0 }, supported_by: ['read-it'] },
  ];
  // Deliberately specified by the operator: an exact identity this proposition
  // depends on, which this checkout does not happen to contain.
  draft.proposition.requires = [{ ref: 'upstream', digest: UPSTREAM }];
  draft.questions = [
    {
      id: 'Q1',
      question: 'Is the upstream schema normative for these assertions?',
      blocking: true,
      resolution: 'Yes. Pin it exactly; the artifact lives in the release registry.',
      resolved_by: 'a.operator',
    },
  ];
  writeJson('.release-harness/drafts/pinned.draft.json', draft);

  const record = readJson('.release-harness/drafts/pinned.record.json');
  record.claims = [
    {
      id: 'read-it',
      claim: 'the CLI exits 0',
      status: 'observed',
      evidence: { source: 'bin/tool.js:1' },
    },
  ];
  writeJson('.release-harness/drafts/pinned.record.json', record);

  const accept = rh(dir, ['accept', '--draft', 'pinned', '--by', 'a.operator']);
  assert.strictEqual(accept.code, 0, 'an operator-confirmed proposition must be acceptable');

  acceptedDigest = accept.all.match(/Accepted ([0-9a-f]{16})/)?.[1];
  assert.ok(acceptedDigest, 'acceptance reports the digest');

  // Nothing anywhere may claim the reference was checked.
  const validate = rh(dir, ['validate']);
  assert.ok(
    !/resolved|verified/i.test(validate.all),
    'no output may claim an unavailable reference was resolved'
  );

  pass('R2', 'a deliberately pinned, currently unavailable reference can be accepted');
}

// ---------------------------------------------------------------------------
// R3 + R4  It is not certifying-ready, and the run refuses before acting.
// ---------------------------------------------------------------------------
{
  rh(dir, ['bind', 'local', '--target', 'cli=node --version']);

  const doctor = rh(dir, ['doctor']);
  assert.match(doctor.all, /no\s+--/, 'doctor must not call it certifying-ready');
  assert.match(doctor.all, /NORMATIVE_REF_UNRESOLVED/, 'and must name the reason');

  const runsDir = path.join(dir, '.release-harness', 'runs');
  const before = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;

  const run = rh(dir, ['run', '--binding', 'local']);
  assert.notStrictEqual(run.code, 0, 'the run must refuse');
  assert.match(run.all, /NORMATIVE_REF_UNRESOLVED/, 'naming the unresolved reference');
  assert.match(run.all, /was not started/i, 'and saying nothing executed');
  assert.ok(!/Status: PASS/.test(run.all), 'it cannot pass');

  const after = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
  assert.strictEqual(after, before, 'and must produce no side effects');

  pass('R3+R4', 'unresolved reference: not ready, run refuses, zero assertions executed');
}

// ---------------------------------------------------------------------------
// R5  THE INVARIANT. The same accepted contract certifies once the referent
//     appears -- without re-acceptance, and with its digest unchanged.
// ---------------------------------------------------------------------------
{
  const acceptedDir = path.join(dir, '.release-harness', 'accepted');
  const before = fs
    .readdirSync(acceptedDir)
    .filter((f) => f.endsWith('.contract.json'))
    .sort();

  // The environment gains the referenced proposition. Nothing about the
  // accepted contract changes -- this is a fact about the machine, not the
  // promise.
  writeJson(`.release-harness/accepted/${UPSTREAM}.contract.json`, {
    schema_version: '1.0.0',
    subject: { id: 'upstream' },
    assertions: [{ id: 'X', kind: 'cli', target: 'cli', expect: { exit_code: 0 } }],
    digest: UPSTREAM,
  });

  const doctor = rh(dir, ['doctor']);
  assert.match(doctor.all, /yes --/, 'doctor must now report it certifying-ready');

  const run = rh(dir, ['run', '--binding', 'local', '--contract', acceptedDigest]);
  assert.match(run.all, /Status: PASS/, 'the same contract must now certify');
  assert.strictEqual(run.code, 0, 'exiting 0');

  // The decisive assertion: the accepted artifact is byte-for-byte the one
  // accepted before the referent existed.
  const after = fs
    .readdirSync(acceptedDir)
    .filter((f) => f.endsWith('.contract.json') && !f.startsWith(UPSTREAM))
    .sort();
  assert.deepStrictEqual(
    after,
    before.filter((f) => !f.startsWith(UPSTREAM)),
    'no new contract may be emitted: availability is not part of identity'
  );
  assert.ok(
    after.some((f) => f.startsWith(acceptedDigest)),
    'and the original digest must still be the one that certified'
  );

  pass('R5', 'the same accepted digest certifies once its referent appears, with no re-acceptance');
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n  ${results.length} accepted-vs-ready invariants passed\n`);
