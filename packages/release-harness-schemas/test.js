import assert from 'node:assert';
import { Schemas, loadSchema } from './index.js';

console.log('Testing schema definitions...');

// The six schemas the contract model publishes, in lifecycle order: a draft is
// proposed, an authoring record says how its claims were arrived at, an
// accepted contract freezes the proposition, a run manifest records what was
// exercised and where, evidence is sealed, and a verdict adjudicates.
//
// This list used to name nine, six of which described topology, origins,
// scenarios, brand contracts and waivers. They were deleted with the
// architecture that read them -- a world where execution bindings and
// assertions were hashed as one unit, so changing a port changed the identity
// of a promise. The test kept requiring them long after they were gone, which
// is how a suite that nobody runs starts reporting on a product that no longer
// exists.
const PUBLISHED = [
  'DraftV1',
  'AuthoringRecordV1',
  'ContractV1',
  // What each assertion kind may promise, and which fields the executor reads.
  // One authority, consumed by the draft schema, the contract schema, the
  // execution adapter, and the help text -- so a field the schema accepts is a
  // field something consumes, and an author can discover it without provoking
  // a validation error.
  'AssertionKindsV1',
  'RunManifestV1',
  'EvidenceManifestV1',
  'VerdictV1',
];

for (const name of PUBLISHED) {
  assert.ok(Schemas[name], `${name} should load`);
  assert.ok(Schemas[name].$id, `${name} should declare an $id`);
  assert.match(
    Schemas[name].$id,
    /^https:\/\/json\.xibo\.dev\/schemas\/release-harness\//,
    `${name}'s $id should be a published URL`
  );
}

assert.deepStrictEqual(
  Object.keys(Schemas).sort(),
  [...PUBLISHED].sort(),
  'the published set must be exactly these -- no more, and none missing'
);

// The removed schemas must stay removed. A file left behind would be loadable
// by anything that still remembers its name, which is how a deleted
// architecture comes back one import at a time.
for (const gone of [
  'topology-v1',
  'origins-v1',
  'scenario-v1',
  'brand-contract-v1',
  'waivers-v1',
  'harness-config-v1',
]) {
  assert.throws(
    () => loadSchema(gone),
    /Schema not found/,
    `${gone} was removed with its architecture and must not be loadable`
  );
}

console.log('✓ the published schemas load and the removed ones are gone');

// --- verdict ---------------------------------------------------------------

const runIntegrityEnum = Schemas.VerdictV1.properties.run_integrity.enum;
assert.deepStrictEqual(runIntegrityEnum, ['COMPLETE', 'HARNESS_ERROR', 'EVIDENCE_INVALID']);

console.log('✓ verdict run_integrity enum is intact');

// --- contract identity -----------------------------------------------------

// The contract schema must refuse execution bindings structurally. This is the
// counterpart to the digest excluding them: if the schema accepted a binding,
// it could sit inside an accepted contract and go uncovered by the identity
// that certificate rests on.
const contract = Schemas.ContractV1;
assert.strictEqual(
  contract.additionalProperties,
  false,
  'the contract schema must be closed, or a binding could hide inside a contract'
);
assert.deepStrictEqual(
  contract.required,
  ['schema_version', 'subject', 'assertions'],
  'a contract must name a subject and assert something'
);
assert.strictEqual(
  contract.properties.assertions.minItems,
  1,
  'a contract asserting nothing certifies nothing'
);

// A normative reference must be pinned. An unpinned one is a convention, not a
// reference -- the cross-repo failure this project exists to catch.
const ref = contract.definitions.normativeReference;
assert.deepStrictEqual(ref.required, ['ref', 'digest'], 'a normative reference must carry a digest');
assert.strictEqual(ref.properties.digest.pattern, '^[0-9a-f]{64}$', 'and it must be a sha256');

console.log('✓ contract schema is closed and pins its normative references');

// --- authoring record ------------------------------------------------------

// The rule that matters most in the whole vocabulary: an absence established by
// searching must state that the search completed. A killed, timed-out or
// truncated search establishes nothing, and the schema enforces that
// independently of any runtime check -- so a record written by another tool
// cannot carry an unbounded absence either.
const claim = Schemas.AuthoringRecordV1.definitions.claim;
const absenceRule = claim.allOf.find((r) => r.if?.properties?.status?.const === 'observed_absent');

assert.ok(absenceRule, 'the schema must have a rule for observed_absent');
assert.deepStrictEqual(
  absenceRule.then.properties.evidence.required.sort(),
  ['completed', 'method', 'roots'],
  'a searched absence must carry its method, roots and completion'
);
assert.strictEqual(
  absenceRule.then.properties.evidence.properties.completed.const,
  true,
  'completed must be true -- an unfinished search cannot establish absence'
);

assert.deepStrictEqual(
  claim.properties.status.enum.sort(),
  ['asserted_absent', 'inferred', 'not_established', 'observed', 'observed_absent'],
  'the epistemic vocabulary must be exactly these five statuses'
);

console.log('✓ authoring record enforces bounded, completed absence');

console.log('All schema tests PASSED.\n');
