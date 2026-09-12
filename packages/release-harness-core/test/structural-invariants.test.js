// Structural invariants that make the C1 defect classes hard to reintroduce.
//
// Each test here corresponds to a class of defect rather than an instance. C1
// produced ten defects, and five of them were the same mistake: a fix applied
// to one of two places. Patching the instances would have left the classes
// alive, so these assert the property instead.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { Schemas } from '../../release-harness-schemas/index.js';
import { auditClosure } from '../../../scripts/schema-closure-audit.mjs';
import { EXECUTABLE_KINDS, describeAssertionKinds } from '../src/contract.js';
import { assessDraft } from '../src/assess.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nStructural invariants (C2)\n');

// ---------------------------------------------------------------------------
// S-1  Exactly one authored adoption protocol exists.
//
// D9: the repository held two independently editable copies. The D8 fix landed
// in one of them, and every adopter running `init` received the other -- for as
// long as nobody thought to compare them. Synchronising the copies would have
// left two authorities; the fix is that only one is authored.
// ---------------------------------------------------------------------------
{
  const authored = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      // `generated/` is produced by scripts/sync-protocol.mjs and git-ignored.
      if (entry.name === 'generated') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'ADOPTION.md') authored.push(path.relative(REPO, full));
    }
  })(REPO);

  assert.deepStrictEqual(
    authored,
    ['protocol' + path.sep + 'ADOPTION.md'],
    `exactly one authored protocol must exist; found: ${authored.join(', ')}`
  );

  pass('S-1', 'exactly one adoption protocol is authored in the repository');
}

// ---------------------------------------------------------------------------
// S-2  Every object in every published schema has made a closure decision.
//
// D14: the draft root was closed and every nested object left open, so
// `proposition.normative_references` validated clean and was silently ignored.
// The test I wrote to prove unknown fields were rejected only checked
// root-level keys -- it passed while certifying its own blind spot.
//
// So this asserts the structural property over the whole schema set rather
// than probing keys someone happened to think of.
// ---------------------------------------------------------------------------
{
  const findings = auditClosure();
  const undecided = findings.filter((f) => f.state === 'OPEN' || f.state === 'CONFLICT');

  assert.deepStrictEqual(
    undecided.map((f) => f.id),
    [],
    'every object node must be closed, a declared map, or per-kind discriminated'
  );
  assert.ok(findings.length > 20, 'the walker must actually be finding nodes');

  pass('S-2', `all ${findings.length} schema object nodes have an explicit closure decision`);
}

// ---------------------------------------------------------------------------
// S-3  Bogus keys are rejected at every depth.
//
// The adversarial half of S-2: the invariant says a decision was made, this
// says the decision has teeth.
// ---------------------------------------------------------------------------
{
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateDraft = ajv.compile(Schemas.DraftV1);
  const validateRecord = ajv.compile(Schemas.AuthoringRecordV1);

  const draft = () => ({
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 's' },
      assertions: [{ id: 'A1', kind: 'cli', target: 't', expect: { exit_code: 0 } }],
      requires: [{ ref: 'r', digest: 'a'.repeat(64) }],
    },
    questions: [{ id: 'Q1', question: 'q', blocking: true }],
  });
  assert.ok(validateDraft(draft()), 'the baseline draft must be valid');

  const depths = [
    ['root', (d) => (d.bogus = 1)],
    ['proposition', (d) => (d.proposition.bogus = 1)],
    // The exact field an agent wrote in C1, believing the protocol asked for it.
    ['proposition.normative_references', (d) => (d.proposition.normative_references = [])],
    ['subject', (d) => (d.proposition.subject.bogus = 1)],
    ['assertion', (d) => (d.proposition.assertions[0].bogus = 1)],
    ['assertion.expect', (d) => (d.proposition.assertions[0].expect.bogus = 1)],
    ['requires item', (d) => (d.proposition.requires[0].bogus = 1)],
    ['question', (d) => (d.questions[0].bogus = 1)],
  ];

  for (const [where, mutate] of depths) {
    const d = draft();
    mutate(d);
    assert.strictEqual(validateDraft(d), false, `an unknown key at ${where} must be rejected`);
  }

  const record = () => ({
    schema_version: '1.0.0',
    claims: [{ id: 'c', claim: 'x', status: 'observed', evidence: { source: 'f:1' } }],
  });
  assert.ok(validateRecord(record()), 'the baseline record must be valid');

  for (const [where, mutate] of [
    ['record root', (r) => (r.bogus = 1)],
    ['claim', (r) => (r.claims[0].bogus = 1)],
    ['evidence', (r) => (r.claims[0].evidence.bogus = 1)],
  ]) {
    const r = record();
    mutate(r);
    assert.strictEqual(validateRecord(r), false, `an unknown key at ${where} must be rejected`);
  }

  pass('S-3', 'unknown keys are rejected at every depth, in both authoring artifacts');
}

// ---------------------------------------------------------------------------
// S-4  Every machine field the protocol names exists in the schema.
//
// D13: the protocol said "normative references" throughout and never named the
// field, which is `requires`. An agent wrote `normative_references`, the open
// schema accepted it, and the one concept that makes cross-repo contracts work
// was silently dropped.
// ---------------------------------------------------------------------------
{
  const protocolText = fs.readFileSync(path.join(REPO, 'protocol', 'ADOPTION.md'), 'utf8');

  // Fields the protocol instructs an author to write, as `proposition.requires`
  // style references in backticks.
  const named = [...protocolText.matchAll(/`(proposition\.[a-z_.[\]]+|[a-z_]+\.[a-z_]+)`/g)]
    .map((m) => m[1])
    .filter((f) => f.startsWith('proposition.') || f.startsWith('evidence.'));

  assert.ok(named.length > 0, 'the protocol must name the machine fields it asks authors to write');

  const draftSchema = Schemas.DraftV1.properties.proposition;
  const evidenceSchema = Schemas.AuthoringRecordV1.definitions.claim.properties.evidence;

  for (const field of new Set(named)) {
    const [root, ...rest] = field.split('.');
    const leaf = rest[0];
    const target = root === 'proposition' ? draftSchema : evidenceSchema;
    assert.ok(
      Object.prototype.hasOwnProperty.call(target.properties, leaf),
      `the protocol names \`${field}\`, which no schema defines`
    );
  }

  // And the concept that caused D13 must now be named by its real field.
  assert.match(
    protocolText,
    /`proposition\.requires`/,
    'the protocol must tell an author exactly where normative references go'
  );

  pass('S-4', 'every machine field the protocol names exists in the schema');
}

// ---------------------------------------------------------------------------
// S-5  Every accepted assertion field is read by an executor.
//
// D18: `expect.command` was accepted by the schema, used by this project's own
// example, and read by nothing. An author copying the example wrote a
// decorative assertion that silently ran the bare binding.
// ---------------------------------------------------------------------------
{
  const executor = fs.readFileSync(
    path.join(REPO, 'packages', 'release-harness-core', 'src', 'execute.js'),
    'utf8'
  );
  const kinds = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'packages', 'release-harness-schemas', 'schemas', 'assertion-kinds-v1.json'),
      'utf8'
    )
  );

  for (const kind of EXECUTABLE_KINDS) {
    const declared = Object.keys(kinds.definitions[kind].properties);
    assert.ok(declared.length > 0, `${kind} must declare an expect vocabulary`);

    for (const field of declared) {
      assert.ok(
        executor.includes(`expect.${field}`),
        `the schema accepts \`expect.${field}\` for kind "${kind}", but no executor reads it`
      );
    }
  }

  // The specific dead field, gone from schema and examples alike.
  assert.ok(!executor.includes('expect.command'), 'expect.command must not be read');
  for (const kind of EXECUTABLE_KINDS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(kinds.definitions[kind].properties, 'command'),
      `expect.command must not be declared for kind "${kind}"`
    );
  }

  pass('S-5', 'every accepted assertion field is consumed by an executor');
}

// ---------------------------------------------------------------------------
// S-6  A question resolution names who made it.
//
// D11: a bare `resolution` cleared a blocking question. The protocol forbids an
// agent answering its own semantic question, but the artifact could not
// evidence the violation -- so an audit could not tell operator from agent.
// ---------------------------------------------------------------------------
{
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateDraft = ajv.compile(Schemas.DraftV1);

  const withQuestion = (q) => ({
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 's' },
      assertions: [{ id: 'A1', kind: 'cli', target: 't', expect: { exit_code: 0 } }],
    },
    questions: [q],
  });

  assert.ok(
    validateDraft(withQuestion({ id: 'Q1', question: 'q', blocking: true })),
    'an unresolved question is valid'
  );
  assert.ok(
    validateDraft(
      withQuestion({ id: 'Q1', question: 'q', blocking: true, resolution: 'yes', resolved_by: 'op' })
    ),
    'an attributed resolution is valid'
  );
  assert.strictEqual(
    validateDraft(withQuestion({ id: 'Q1', question: 'q', blocking: true, resolution: 'yes' })),
    false,
    'a resolution with no resolved_by must be refused'
  );

  pass('S-6', 'a question resolution must name who made it');
}

// ---------------------------------------------------------------------------
// S-7  Blockers render through one implementation.
//
// D1 and D17 were the same defect found twice: `validate` summarised and
// `doctor` did not, because the fix was applied to one file.
// ---------------------------------------------------------------------------
{
  const cliDir = path.join(REPO, 'packages', 'release-harness-core', 'src', 'cli');
  const files = fs.readdirSync(cliDir).filter((f) => f.endsWith('.js') && f !== 'blockers.js');

  for (const file of files) {
    const code = fs.readFileSync(path.join(cliDir, file), 'utf8');
    // Draft blockers specifically -- `verify` renders chain breaks, which are a
    // different concept that happens to use the same field name. Matching on
    // the variable alone made this test claim a defect that was not there.
    const rendersBlockers = /assessment\.blockers|blockers[\s\S]{0,80}out\.detail/.test(code);
    if (!rendersBlockers) continue;
    assert.match(
      code,
      /from '\.\/blockers\.js'/,
      `${file} renders blockers and must import the shared renderer`
    );
  }

  pass('S-7', 'anything that renders a blocker uses the one shared renderer');
}

// ---------------------------------------------------------------------------
// S-8  Every command that reports draft readiness consumes one assessment.
//
// D23: `draft status` called checkAcceptability directly, so it never saw the
// contract-standard blockers and reported 4 where validate reported 5. An
// operator working from `status` was told there was less to do than acceptance
// would enforce. D10 was the same class in different commands, so this asserts
// the property rather than the instance.
// ---------------------------------------------------------------------------
{
  const cliDir = path.join(REPO, 'packages', 'release-harness-core', 'src', 'cli');
  const readiness = ['draft.js', 'validate.js', 'accept.js', 'doctor.js'];

  for (const file of readiness) {
    const code = fs.readFileSync(path.join(cliDir, file), 'utf8');

    assert.match(
      code,
      /assessDraft/,
      `${file} reports draft readiness and must consume the shared assessment`
    );

    // Reconstructing acceptability from the lower-level checks is how two
    // answers drift apart in the first place.
    for (const bypass of ['checkAcceptability', 'checkContractSemantics', 'contractSemanticFindings']) {
      assert.ok(
        !new RegExp(bypass + '\\s*\\(').test(code),
        `${file} must not call ${bypass} directly; assessDraft is the authority`
      );
    }
  }

  pass('S-8', 'draft status, validate, accept and doctor share one assessment');
}

// ---------------------------------------------------------------------------
// S-9  One blocker per semantic violation -- and distinct ones survive.
//
// D24: a scaffold reported both "assertions[0] has no kind yet" and
// "assertions[0] must declare a kind" -- two layers finding one fact. Dedup
// keys on semantic identity, never on wording, so improving a message cannot
// silently reintroduce the duplicate.
// ---------------------------------------------------------------------------
{
  const scaffold = assessDraft(
    {
      schema_version: '1.0.0',
      proposition: { subject: { id: '' }, assertions: [{ id: 'A1', kind: '', target: '' }] },
      questions: [],
    },
    { schema_version: '1.0.0', claims: [] }
  );

  const keys = scaffold.blockers.map((b) => `${b.code}|${b.path}|${b.entity ?? ''}`);
  assert.strictEqual(
    new Set(keys).size,
    keys.length,
    `the same semantic violation must be reported once; got ${keys.join(', ')}`
  );
  assert.ok(
    scaffold.blockers.every((b) => b.code),
    'every blocker must carry a machine identity, or it cannot be deduplicated'
  );

  // Distinct conditions on the same field must BOTH survive: a missing kind and
  // an unexecutable one have different remedies, and collapsing them by path
  // would hide one.
  const unsupported = assessDraft(
    {
      schema_version: '1.0.0',
      proposition: { subject: { id: 's' }, assertions: [{ id: 'A1', kind: 'process', target: '' }] },
      questions: [],
    },
    { schema_version: '1.0.0', claims: [] }
  );
  const codes = unsupported.blockers.map((b) => b.code);
  assert.ok(codes.includes('ASSERTION_KIND_UNSUPPORTED'), 'an unexecutable kind must be reported');
  assert.ok(
    codes.includes('ASSERTION_TARGET_MISSING'),
    'and a different violation on a sibling field must survive alongside it'
  );

  pass('S-9', 'blockers deduplicate by semantic identity, not by wording');
}

// ---------------------------------------------------------------------------
// S-10  The assertion vocabulary is rendered from the schema, not restated.
//
// D19: C2 made the vocabulary strict without making it visible, and an agent
// learned it by submitting invalid values. Help must derive from the same file
// validation compiles, so the two cannot drift.
// ---------------------------------------------------------------------------
{
  const kinds = describeAssertionKinds();
  assert.ok(kinds.length > 0, 'the vocabulary must be describable');

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'packages', 'release-harness-schemas', 'schemas', 'assertion-kinds-v1.json'),
      'utf8'
    )
  );

  for (const { kind, expect } of kinds) {
    const declared = Object.keys(schema.definitions[kind].properties);
    assert.deepStrictEqual(
      expect.map((e) => e.field).sort(),
      declared.sort(),
      `the described vocabulary for "${kind}" must be exactly what the schema declares`
    );
  }

  // And the CLI must not carry its own copy of any field name.
  const draftCli = fs.readFileSync(
    path.join(REPO, 'packages', 'release-harness-core', 'src', 'cli', 'draft.js'),
    'utf8'
  );
  // Matching bare field names would be wrong: `status` is an http expect field
  // AND the name of the `draft status` subcommand. What must not appear is a
  // hardcoded expect VOCABULARY -- a list of those names together.
  const kindVocabularies = kinds.map((k) => k.expect.map((e) => e.field));
  for (const fields of kindVocabularies) {
    if (fields.length < 2) continue;
    const restated = fields.every((f) => new RegExp(`['"\`]${f}['"\`]`).test(draftCli));
    assert.ok(
      !restated,
      `draft.js contains the whole expect vocabulary (${fields.join(', ')}); render it from the authority instead`
    );
  }

  pass('S-10', 'assertion vocabulary is derived from the schema, not duplicated in the CLI');
}

// ---------------------------------------------------------------------------
// S-11  Normative references resolve through one authority.
//
// D25: the run built its own resolution map and `doctor` called readiness
// without one, so doctor reported every reference unresolved -- including ones
// whose referent was on disk. A readiness command that cannot see an available
// dependency teaches the operator to disbelieve it.
// ---------------------------------------------------------------------------
{
  const cliDir = path.join(REPO, 'packages', 'release-harness-core', 'src', 'cli');

  for (const file of ['run.js', 'doctor.js']) {
    const code = fs.readFileSync(path.join(cliDir, file), 'utf8');
    assert.match(
      code,
      /resolveNormativeReferences/,
      `${file} decides on normative references and must use the shared resolver`
    );
  }

  // Resolution is by exact identity, and must never execute anything.
  const resolver = fs.readFileSync(
    path.join(REPO, 'packages', 'release-harness-core', 'src', 'normative.js'),
    'utf8'
  );
  // Strip comments before checking: the file's own prose explains that it does
  // not execute anything, and matching that text would have the test report a
  // defect in its own documentation.
  const resolverCode = resolver
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('//'))
    .join(String.fromCharCode(10));

  for (const forbidden of ['spawn(', 'exec(', 'execSync', 'executeAssertion', 'probeHttp']) {
    assert.ok(
      !resolverCode.includes(forbidden),
      `the resolver must not call ${forbidden}: observing readiness may not run the subject`
    );
  }

  pass('S-11', 'one read-only normative-reference resolver, shared by run and doctor');
}


console.log(`\n  ${results.length} structural invariants passed\n`);
