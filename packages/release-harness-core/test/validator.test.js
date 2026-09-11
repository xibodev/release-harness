import assert from 'node:assert';
import {
  validateAcceptedContract,
  validateDraft,
  validateAuthoringRecord,
  ValidationError,
} from '../src/validator.js';
import { acceptDraft } from '../src/acceptance.js';

console.log('Running validation-authority tests...');

// The contract-model documents go through one validation path.
//
// Schema owns shape, enumerations and per-status evidence requirements; runtime
// owns the rules that must look in more than one place at once. The failure
// that matters is a rule living in both, drifting, and leaving two answers to
// one question -- so each check below asserts which authority spoke.
{
  const draft = {
    schema_version: '1.0.0',
    proposition: {
      subject: { id: 'checkout-service' },
      assertions: [
        { id: 'A1', kind: 'http', target: 'api', expect: { status: 200 }, supported_by: ['c1'] },
      ],
    },
  };
  const record = {
    schema_version: '1.0.0',
    claims: [
      {
        id: 'c1',
        claim: 'api serves /health',
        status: 'observed',
        evidence: { source: 'compose.yml:4' },
      },
    ],
  };
  const contract = acceptDraft(draft, record, { by: 'op', at: '2026-09-11T00:00:00Z' });

  assert.strictEqual(validateDraft(draft), true, 'a well-formed draft validates');
  assert.strictEqual(validateAuthoringRecord(record), true, 'a sound authoring record validates');
  assert.strictEqual(
    validateAcceptedContract(contract),
    true,
    'an accepted contract validates despite carrying its acceptance envelope'
  );

  // A draft is ALLOWED to be incomplete. Validating it as a contract would make
  // an author fake completeness before they have it.
  assert.strictEqual(
    validateDraft({
      schema_version: '1.0.0',
      proposition: { subject: { id: 's' }, assertions: [{ id: 'A1' }] },
    }),
    true,
    'an incomplete draft is still a valid draft'
  );

  // Integrity is part of validation: a contract that satisfies every shape rule
  // but no longer matches its digest is not the contract anyone agreed to.
  const tampered = JSON.parse(JSON.stringify(contract));
  tampered.assertions[0].expect.status = 500;
  assert.throws(
    () => validateAcceptedContract(tampered),
    (err) => err instanceof ValidationError && /integrity check/.test(err.message),
    'a contract edited after acceptance must fail validation'
  );

  // The schema is the authority for per-status evidence, so this must fail
  // there rather than at runtime -- proving the rule is enforced for any
  // document, however it was produced.
  assert.throws(
    () =>
      validateAuthoringRecord({
        schema_version: '1.0.0',
        claims: [
          {
            id: 'c',
            claim: 'x',
            status: 'observed_absent',
            evidence: { method: 'm', roots: ['.'] },
          },
        ],
      }),
    (err) => err instanceof ValidationError && /schema validation/.test(err.message),
    'an absence claim that never says whether its search completed must be refused by the schema'
  );

  // Runtime owns what the schema cannot see: assertions cite claims by id, so a
  // duplicate id makes the citation ambiguous.
  assert.throws(
    () =>
      validateAuthoringRecord({
        schema_version: '1.0.0',
        claims: [
          { id: 'dup', claim: 'a', status: 'observed', evidence: { source: 'f' } },
          { id: 'dup', claim: 'b', status: 'observed', evidence: { source: 'g' } },
        ],
      }),
    (err) => err instanceof ValidationError && err.errors.some((e) => /Duplicate claim id/.test(e)),
    'duplicate claim ids must be caught at runtime, where the whole list is visible'
  );

  console.log(
    '✓ vNext contract, draft and authoring-record documents share the one validation path'
  );
}
console.log('All validation-authority tests PASSED.\n');
