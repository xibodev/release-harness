// Identity invariants for the accepted contract.
//
// The digest identifies a proposition. Two properties make a certificate mean
// something, and both are tested here:
//
//   1. Semantically identical propositions have identical digests, regardless
//      of how they were serialized, ordered, or spelled.
//   2. A changed proposition has a changed digest -- including a changed
//      normative reference, because that changes what the assertion means.
//
// And the converse, which is the whole point of separating bindings: changing
// where or how a proposition is exercised must NOT change its identity.

import assert from 'node:assert';
import Ajv from 'ajv';
import { Schemas } from '../../release-harness-schemas/index.js';
import {
  canonicalizeContract,
  canonicalSerialize,
  contractDigest,
  checkContractSemantics,
} from '../src/contract.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nContract identity invariants\n');

// A minimal well-formed proposition, used as the baseline throughout.
const base = {
  schema_version: '1.0.0',
  subject: { id: 'checkout-service', name: 'Checkout Service' },
  assertions: [
    { id: 'A1', kind: 'http', target: 'api', expect: { status: 200, path: '/health' } },
  ],
};

// ---------------------------------------------------------------------------
// I-1  Key order, whitespace and formatting do not move the digest.
// ---------------------------------------------------------------------------
{
  const reordered = {
    assertions: [
      { expect: { path: '/health', status: 200 }, target: 'api', kind: 'http', id: 'A1' },
    ],
    subject: { name: 'Checkout Service', id: 'checkout-service' },
    schema_version: '1.0.0',
  };

  assert.strictEqual(
    contractDigest(reordered),
    contractDigest(base),
    'property order must not change proposition identity'
  );

  // Round-tripping through pretty-printed JSON must also agree.
  const prettied = JSON.parse(JSON.stringify(base, null, 4));
  assert.strictEqual(
    contractDigest(prettied),
    contractDigest(base),
    'whitespace and pretty-printing must not change identity'
  );

  pass('I-1a', 'key order and formatting do not move the digest');
}

// ---------------------------------------------------------------------------
// I-1b  Unicode spelling does not move the digest.
//
// "café" can be composed or decomposed. Both are the same proposition.
// ---------------------------------------------------------------------------
{
  const composed = { ...base, subject: { id: 'café-service' } };
  const decomposed = { ...base, subject: { id: 'café-service' } };

  assert.notStrictEqual(
    JSON.stringify(composed),
    JSON.stringify(decomposed),
    'the two spellings must differ before normalization, or this test proves nothing'
  );
  assert.strictEqual(
    contractDigest(composed),
    contractDigest(decomposed),
    'NFC normalization must make unicode spellings agree'
  );

  pass('I-1b', 'unicode spelling does not move the digest');
}

// ---------------------------------------------------------------------------
// I-1c  Execution bindings are excluded from identity by construction.
//
// The same proposition run locally and against staging must have one identity.
// This is the property that lets a contract be certified in CI after being
// authored on a laptop.
// ---------------------------------------------------------------------------
{
  const withLocalBinding = {
    ...base,
    bindings: { api: 'http://127.0.0.1:3000' },
    evidence_dir: '/tmp/local-run',
  };
  const withStagingBinding = {
    ...base,
    bindings: { api: 'https://staging.example.com' },
    evidence_dir: '/var/ci/evidence',
  };

  assert.strictEqual(
    contractDigest(withLocalBinding),
    contractDigest(base),
    'a binding present on the object must not enter identity'
  );
  assert.strictEqual(
    contractDigest(withLocalBinding),
    contractDigest(withStagingBinding),
    'local and staging bindings must yield one identity'
  );

  pass('I-1c', 'execution bindings do not participate in identity');
}

// ---------------------------------------------------------------------------
// I-1d  Authoring and acceptance metadata are excluded from identity.
//
// Who accepted it, when, and which agent proposed it are real and recorded --
// but a proposition accepted twice by two people is one proposition.
// ---------------------------------------------------------------------------
{
  const annotated = {
    ...base,
    accepted_by: 'a.operator',
    accepted_at: '2026-09-10T14:31:00Z',
    authoring_session: 'sess-abc123',
    provenance: [{ claim: 'port', status: 'observed', source: 'compose.yml' }],
  };

  assert.strictEqual(
    contractDigest(annotated),
    contractDigest(base),
    'acceptance and authoring metadata must not change identity'
  );

  pass('I-1d', 'acceptance and authoring metadata do not enter identity');
}

// ---------------------------------------------------------------------------
// I-2  A changed assertion changes the digest.
// ---------------------------------------------------------------------------
{
  const changedExpectation = JSON.parse(JSON.stringify(base));
  changedExpectation.assertions[0].expect.status = 204;

  assert.notStrictEqual(
    contractDigest(changedExpectation),
    contractDigest(base),
    'changing what must hold must change the proposition'
  );

  const addedAssertion = JSON.parse(JSON.stringify(base));
  addedAssertion.assertions.push({ id: 'A2', kind: 'http', target: 'api' });

  assert.notStrictEqual(
    contractDigest(addedAssertion),
    contractDigest(base),
    'adding an assertion must change the proposition'
  );

  const changedSubject = { ...base, subject: { id: 'other-service' } };
  assert.notStrictEqual(
    contractDigest(changedSubject),
    contractDigest(base),
    'changing the subject must change the proposition'
  );

  pass('I-2a', 'changed assertions and subject change the digest');
}

// ---------------------------------------------------------------------------
// I-2b  A changed normative reference changes the digest.
//
// This is the C-004 invariant: a schema owned in one repo and consumed in
// another broke production because nothing pinned the relationship. If the
// referenced proposition changes, the meaning of this assertion changes, so
// the identity must change too.
// ---------------------------------------------------------------------------
{
  const d1 = 'a'.repeat(64);
  const d2 = 'b'.repeat(64);

  const withRef = { ...base, requires: [{ ref: 'usage-table-schema', digest: d1 }] };
  const withOtherRef = { ...base, requires: [{ ref: 'usage-table-schema', digest: d2 }] };

  assert.notStrictEqual(
    contractDigest(withRef),
    contractDigest(base),
    'adding a normative reference must change the proposition'
  );
  assert.notStrictEqual(
    contractDigest(withRef),
    contractDigest(withOtherRef),
    'a changed normative digest must change the proposition'
  );

  pass('I-2b', 'normative references participate in identity');
}

// ---------------------------------------------------------------------------
// I-3  The canonical form is reproducible and inspectable.
//
// A digest nobody else can recompute is a number, not an identity. The canonical
// serialization must be stable and must contain only identity fields.
// ---------------------------------------------------------------------------
{
  const serialized = canonicalSerialize({ ...base, bindings: { api: 'http://x' } });
  assert.ok(!serialized.includes('bindings'), 'canonical form must exclude non-identity fields');
  assert.ok(serialized.startsWith('{"assertions"'), 'canonical form must be key-sorted');
  assert.strictEqual(
    canonicalSerialize(base),
    canonicalSerialize(JSON.parse(canonicalSerialize(base))),
    'canonicalization must be idempotent'
  );

  const canon = canonicalizeContract(base);
  assert.deepStrictEqual(
    Object.keys(canon),
    ['assertions', 'schema_version', 'subject'],
    'only identity fields survive canonicalization'
  );

  pass('I-3', 'canonical form is sorted, minimal and idempotent');
}

// ---------------------------------------------------------------------------
// I-4  Unportable values are rejected rather than silently hashed.
//
// A float's serialization is not portable across implementations, so a digest
// containing one is not reproducible. Rejecting is honest; hashing is not.
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => contractDigest({ ...base, subject: { id: 's', weight: 1.5 } }),
    /safe integer/,
    'fractional numbers must be rejected'
  );
  assert.throws(
    () => contractDigest({ ...base, subject: { id: 's', when: new Date() } }),
    /unsupported type|safe integer/,
    'non-primitive values must be rejected'
  );

  pass('I-4', 'unportable values are rejected, not silently hashed');
}

// ---------------------------------------------------------------------------
// I-5  Semantic checks catch what a digest cannot.
//
// A well-formed digest over a meaningless contract is still meaningless. These
// are the cross-field rules a schema expresses poorly.
// ---------------------------------------------------------------------------
{
  assert.ok(
    checkContractSemantics(base).length === 0,
    'the baseline contract must be semantically clean'
  );

  const noAssertions = { ...base, assertions: [] };
  assert.ok(
    checkContractSemantics(noAssertions).some((e) => /non-empty "assertions"/.test(e)),
    'a contract asserting nothing must be rejected'
  );

  const dupIds = JSON.parse(JSON.stringify(base));
  dupIds.assertions.push({ id: 'A1', kind: 'http', target: 'api' });
  assert.ok(
    checkContractSemantics(dupIds).some((e) => /Duplicate assertion id/.test(e)),
    'duplicate assertion ids must be rejected'
  );

  const unpinnedRef = { ...base, requires: [{ ref: 'some-schema' }] };
  assert.ok(
    checkContractSemantics(unpinnedRef).some((e) => /digest must be a sha256/.test(e)),
    'a normative reference without a digest is a convention, not a reference'
  );

  pass('I-5', 'semantic checks reject empty, duplicated and unpinned content');
}

// ---------------------------------------------------------------------------
// I-6  The schema and the digest agree about what a contract is.
//
// These are two authorities over one artifact: the schema decides shape, the
// canonicalizer decides identity. If they drift, a field the schema accepts but
// the digest ignores becomes a place to hide a change -- a binding accepted into
// a contract and then silently absent from what the certificate covers. So the
// rule is tested directly: the schema must REFUSE anything identity excludes.
// ---------------------------------------------------------------------------
{
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateContract = ajv.compile(Schemas.ContractV1);

  assert.ok(validateContract(base), 'the baseline contract must satisfy the schema');

  // Every field excluded from identity must be structurally refused, so it can
  // never sit inside an accepted contract and go uncovered by the digest.
  const excluded = {
    bindings: { api: 'http://127.0.0.1:3000' },
    evidence_dir: '/tmp/run',
    accepted_by: 'a.operator',
    accepted_at: '2026-09-10T14:31:00Z',
    authoring_session: 'sess-abc123',
    provenance: [{ claim: 'port', status: 'observed' }],
    digest: 'f'.repeat(64),
  };

  for (const [field, value] of Object.entries(excluded)) {
    const contaminated = { ...base, [field]: value };

    assert.strictEqual(
      contractDigest(contaminated),
      contractDigest(base),
      `"${field}" must not enter the digest`
    );
    assert.strictEqual(
      validateContract(contaminated),
      false,
      `the schema must refuse "${field}" rather than accept a field the digest ignores`
    );
  }

  // And the converse: everything the schema requires must be identity-bearing,
  // or the schema would be demanding something the certificate does not cover.
  const identityKeys = Object.keys(canonicalizeContract({ ...base, requires: [] }));
  for (const required of Schemas.ContractV1.required) {
    assert.ok(
      identityKeys.includes(required),
      `schema requires "${required}", so it must participate in identity`
    );
  }

  pass('I-6', 'schema shape and digest identity cover exactly the same fields');
}

console.log(`\n  ${results.length} identity invariants passed\n`);
