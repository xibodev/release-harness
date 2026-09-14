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
import { sameCanonicalText } from '../src/canonical-text.js';
import { execFileSync } from 'node:child_process';

/**
 * Files under source control, POSIX-separated.
 *
 * Source control is the authority question: a file git tracks is one a person
 * edits and whose edit ships. Anything else is a copy.
 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

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
  // D35: this walked for any ADOPTION.md outside a three-name skip list and
  // called every hit "authored". That made the product fail its own suite the
  // moment it was adopted into its own repository, because `init` installs a
  // copy at .release-harness/protocol/ADOPTION.md.
  //
  // The invariant was never about filenames. It is about AUTHORITY: exactly one
  // copy may be edited and have the edit mean something. A generated copy and
  // an installed copy are consequences of the authored one, and a consequence
  // is not a second authority.
  //
  // So authority is decided by source control, which is the mechanism that
  // actually makes a file editable-and-meaningful, rather than by a hand-kept
  // list of directory names that must be remembered every time a new kind of
  // copy appears.
  const tracked = trackedFiles();
  const authored = tracked.filter((f) => path.basename(f) === 'ADOPTION.md');

  assert.deepStrictEqual(
    authored,
    ['protocol/ADOPTION.md'],
    `exactly one authored protocol may be source-controlled; found: ${authored.join(', ')}`
  );

  // And the untracked copies that DO exist must be consequences, not rivals:
  // identical to the authority under canonical text comparison. A copy that has
  // drifted is a second authority no matter where it sits.
  const canonical = fs.readFileSync(path.join(REPO, 'protocol', 'ADOPTION.md'));
  for (const rel of ['.release-harness/protocol/ADOPTION.md']) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) continue;
    assert.ok(
      sameCanonicalText(fs.readFileSync(full), canonical),
      `${rel} exists but has drifted from the authored protocol`
    );
  }

  pass('S-1', 'exactly one adoption protocol carries authority in the repository');
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



// ---------------------------------------------------------------------------
// S-12  The protocol's examples are unmistakably fictional.
//
// D27: the `requires` example used "usage-schema", which was the exact name of
// a dependency in the fixture an agent was adopting. It noticed and refused --
// "treating it as corroboration would have been circular" -- but a less careful
// reader pins a digest because the documentation appeared to confirm a finding.
//
// That is the D8 priming class: an example concrete enough to be mistaken for
// evidence. This does not ban examples; it bans example entity names that could
// plausibly appear in a real dependency tree.
// ---------------------------------------------------------------------------
{
  const protocolText = fs.readFileSync(path.join(REPO, 'protocol', 'ADOPTION.md'), 'utf8');

  // Names that have appeared as real entities in fixtures or real repositories.
  const realLooking = ['usage-schema', 'usage-api', 'usage-client', 'platform-ops', 'equilibria'];
  const found = realLooking.filter((n) => protocolText.includes(n));

  assert.deepStrictEqual(
    found,
    [],
    `the protocol must not name entities that exist in real dependency trees; found: ${found.join(', ')}`
  );

  pass('S-12', 'the adoption protocol names no fixture-like entities');
}


// ---------------------------------------------------------------------------
// S-13  The core model is exactly four things, and stays that way.
//
// THE ARCHITECTURAL CONCLUSION, recorded where it can be enforced rather than
// in prose that nobody re-reads.
//
//     subject + assertions + requires + execution bindings
//
// That model represented, without extension: a 703-file product across three
// repositories; evidence-triggered outward inspection; cross-repo deployment
// relationships; cross-repo normative candidates; contradictory documentation
// and configuration where several sources disclaimed their own authority; an
// incomplete normative identity that could not be pinned; and both executable
// and HTTP propositions.
//
// Earlier designs carried a topology type, repository roles, an origins file
// and a product slug. All of it was deleted, and the real estate needed none of
// it back. Discovering that a repository is a "core API" is an authoring
// conclusion recorded as a claim -- not a field the schema should name.
//
// So changing this model requires a concrete proposition that cannot be
// represented. Not inconvenience, not repo complexity, not product size. A real
// counterexample, plus a demonstration that no assertion primitive would solve
// it -- because D39 and D40 looked like ontology gaps and were both closed by
// adding one field to an existing kind.
// ---------------------------------------------------------------------------
{
  const contract = Schemas.ContractV1;
  const top = Object.keys(contract.properties).sort();

  assert.deepStrictEqual(
    top,
    ['assertions', 'requires', 'schema_version', 'subject'],
    'the contract carries exactly the model -- subject, assertions, requires, and its version'
  );

  // The vocabulary that was deleted must not return by any spelling.
  const forbidden = [
    'topology', 'topology_type', 'repositories', 'repository_role', 'role',
    'origins', 'product_slug', 'component', 'component_type', 'coordinator',
    'release_unit', 'registry', 'scenario',
  ];
  const serialized = JSON.stringify(contract);
  for (const word of forbidden) {
    assert.ok(
      !new RegExp(`"${word}"`).test(serialized),
      `"${word}" describes a topology ontology the real estate did not need`
    );
  }

  pass('S-13', 'the core model is subject + assertions + requires + bindings, and nothing more');
}


// ---------------------------------------------------------------------------
// S-14  The vocabulary an author is TAUGHT is the vocabulary that VALIDATES.
//
// D44. S-5 proved every field in the kinds schema is read by the executor, and
// passed -- while the draft and contract schemas rejected two of those fields
// outright. Both carried hand-copied `expect` rules, so `body_contains` and
// `stderr_contains` existed in the authority, in the executor and in the CLI's
// help, and nowhere in either validator.
//
// An adoption run hit it in minutes: the tool's own `draft new` output taught
// two fields that `validate` refused. That is worse than a missing feature --
// it is the product lying to an author about its own vocabulary, which is the
// precise failure D18 and D19 were about.
//
// S-5 could not have caught it because it only ever looked in one direction.
// This closes the other: every field the author is shown must survive both
// validators, for every kind.
// ---------------------------------------------------------------------------
{
  const ajv = new Ajv({ strict: false, allErrors: true });

  // A minimal well-formed artifact of each shape, with one assertion whose
  // `expect` carries exactly the field under test.
  const sample = (field, spec) => {
    if (Array.isArray(spec.enum)) return spec.enum[0];
    if (spec.type === 'integer') return spec.minimum ?? 0;
    return 'x';
  };

  for (const k of describeAssertionKinds()) {
    const defs = Schemas.AssertionKindsV1.definitions[k.kind].properties;

    for (const [field, spec] of Object.entries(defs)) {
      const expect = { [field]: sample(field, spec) };
      const assertion = { id: 'A1', kind: k.kind, target: 't', expect, supported_by: [] };

      const draft = {
        schema_version: '1.0.0',
        proposition: { subject: { id: 's', name: 's' }, assertions: [assertion] },
        questions: [],
      };
      assert.ok(
        ajv.validate(Schemas.DraftV1, draft),
        `the draft schema rejects \`expect.${field}\` for kind "${k.kind}", ` +
          `but the CLI teaches it: ${ajv.errorsText(ajv.errors)}`
      );

      // `supported_by` is authoring provenance: it belongs to the draft and is
      // deliberately absent from the accepted contract, so the contract sample
      // must not carry it.
      const { supported_by, ...contractAssertion } = assertion;
      const contract = {
        schema_version: '1.0.0',
        subject: { id: 's', name: 's' },
        assertions: [contractAssertion],
      };
      assert.ok(
        ajv.validate(Schemas.ContractV1, contract),
        `the contract schema rejects \`expect.${field}\` for kind "${k.kind}": ` +
          ajv.errorsText(ajv.errors)
      );
    }
  }

  pass('S-14', 'every taught assertion field validates in both the draft and the contract');
}

// ---------------------------------------------------------------------------
// S-15  Lifecycle metadata remains outside proposition identity.
//
// Continuous operation adds source coverage, review and confirmation around an
// accepted contract. None may become a fifth proposition dimension.
// ---------------------------------------------------------------------------
{
  const contract = Schemas.ContractV1;
  for (const forbidden of ['sources', 'reviews', 'coverage', 'base_commit', 'head_commit', 'confirmation']) {
    assert.ok(
      !Object.hasOwn(contract.properties, forbidden),
      `${forbidden} is lifecycle metadata and must not enter the contract schema`
    );
  }
  assert.ok(Schemas.ChangeReviewV1, 'lifecycle review has its own published schema');
  assert.ok(Schemas.ReviewConfirmationV1, 'review confirmation has its own published schema');
  pass('S-15', 'source coverage and reviews surround, never expand, contract identity');
}

// S-16  Provider adapters are activation pointers, never semantic authorities.
{
  const initSource = fs.readFileSync(path.join(REPO, 'packages/release-harness-core/src/cli/init.js'), 'utf8');
  const match = /const ADAPTER = `([\s\S]*?)`;/m.exec(initSource);
  assert.ok(match, 'one canonical thin adapter template must exist');
  const adapter = match[1];
  assert.match(adapter, /\.release-harness\/protocol\/LIFECYCLE\.md/);
  assert.match(adapter, /lifecycle status/);
  for (const semantic of ['reviewed_source_digest', 'reuse_contract', 'review_digest', 'confirmation.events', 'PRODUCT', 'PASS']) {
    assert.ok(!adapter.includes(semantic), `adapter must not duplicate lifecycle semantics: ${semantic}`);
  }
  pass('S-16', 'provider adapters point to one lifecycle protocol and own no semantics');
}

console.log(`\n  ${results.length} structural invariants passed\n`);
