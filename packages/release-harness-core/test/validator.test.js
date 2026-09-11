import assert from 'node:assert';
import {
  validateScenario,
  validateHarnessConfig,
  validateAcceptedContract,
  validateDraft,
  validateAuthoringRecord,
  ValidationError,
} from '../src/validator.js';
import { acceptDraft } from '../src/acceptance.js';

console.log('Running Contract Schema Enforcement Tests...');

function validScenario(overrides = {}) {
  return {
    id: 'SCEN-01',
    name: 'Landing page',
    origin_id: 'web-app',
    tier: 'smoke',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/' }],
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  return {
    schema_version: '1.0.0',
    product_slug: 'demo-product',
    harness_version: '1.0.0',
    port_block: { start: 43000, range: 50 },
    ...overrides,
  };
}

// 1. The baseline documents both validators accept.
{
  assert.strictEqual(validateScenario(validScenario()), true, 'A schema-valid scenario must be accepted');
  assert.strictEqual(validateHarnessConfig(validConfig()), true, 'A schema-valid harness config must be accepted');
  console.log('✓ Schema-valid scenario and harness config are accepted');
}

// 2. expected_side_effects is enforced. The hand-rolled checks never inspected this
//    field, which is how a schema-legal-but-unimplemented probe reached the engine.
{
  // LOAD-BEARING: dropping the validateAgainstSchema call from validateScenario
  // makes each of these throws fail, because no hand-rolled check reads this field.
  assert.throws(
    () => validateScenario(validScenario({
      expected_side_effects: [{ service: 'kafka', probe_type: 'sql_query', params: {} }],
    })),
    (err) => err instanceof ValidationError && /service/.test(err.message),
    'A service outside the schema enum must be rejected'
  );

  assert.throws(
    () => validateScenario(validScenario({
      expected_side_effects: [{ service: 'postgres', probe_type: 'topic_has_message', params: {} }],
    })),
    (err) => err instanceof ValidationError && /probe_type/.test(err.message),
    'A probe_type outside the schema enum must be rejected'
  );

  assert.throws(
    () => validateScenario(validScenario({
      expected_side_effects: [{ service: 'postgres', probe_type: 'sql_query' }],
    })),
    ValidationError,
    'A side effect missing its required params must be rejected'
  );

  // The documented custom probe is schema-legal and must still be accepted.
  assert.strictEqual(
    validateScenario(validScenario({
      expected_side_effects: [
        { service: 'custom', probe_type: 'custom', params: { command: './scripts/probe.sh', expect_exit_code: 0 } },
      ],
    })),
    true,
    'The documented custom probe must remain accepted'
  );

  console.log('✓ expected_side_effects service/probe_type enums are enforced, custom stays legal');
}

// 3. Step actions outside the published pattern are rejected.
{
  assert.throws(
    () => validateScenario(validScenario({ steps: [{ action: 'teleport', target: '/' }] })),
    ValidationError,
    'A step action outside the published pattern must be rejected'
  );
  assert.strictEqual(
    validateScenario(validScenario({ steps: [{ action: 'extension:custom-verb' }] })),
    true,
    'The extension: escape hatch must remain accepted'
  );
  console.log('✓ Step actions are constrained to the published pattern');
}

// 4. pr_gate is executed by check-pr, so the schema must acknowledge it and
//    constrain it. Without the schema addition the first case throws.
{
  assert.strictEqual(
    validateHarnessConfig(validConfig({
      pr_gate: { commands: [{ id: 'lint', cmd: 'npm run lint', timeout_seconds: 120, expected_exit_code: 0 }] },
    })),
    true,
    'A declared pr_gate must be accepted'
  );

  assert.throws(
    () => validateHarnessConfig(validConfig({ pr_gate: { commands: [{ id: 'lint' }] } })),
    (err) => err instanceof ValidationError && /cmd/.test(err.message),
    'A pr_gate command without cmd must be rejected -- the CLI has nothing to execute'
  );

  assert.throws(
    () => validateHarnessConfig(validConfig({ pr_gate: { commands: [{ cmd: ['npm', 'run', 'lint'] }] } })),
    ValidationError,
    'A non-string cmd must be rejected'
  );

  console.log('✓ pr_gate is declared in the schema and its commands are constrained');
}

// 5. Harness config structure the hand-rolled checks never covered.
{
  assert.throws(
    () => validateHarnessConfig(validConfig({ product_slug: 'Not A Slug' })),
    ValidationError,
    'A product_slug violating the published pattern must be rejected'
  );
  assert.throws(
    () => validateHarnessConfig(validConfig({ port_block: { start: 43000 } })),
    ValidationError,
    'A port_block missing range must be rejected'
  );
  assert.throws(
    () => validateHarnessConfig({ schema_version: '1.0.0', product_slug: 'demo', port_block: { start: 43000, range: 50 } }),
    ValidationError,
    'A config missing the required harness_version must be rejected'
  );
  console.log('✓ Harness config structure is enforced beyond the hand-rolled checks');
}

// 5b. harness_version records which tool version wrote the config, so the schema
//     must accept every released version -- not just the one it shipped with.
//     Pinned to enum ['1.0.0'], the schema rejected the config `init` itself writes.
{
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '2.0.0-rc.1']) {
    assert.strictEqual(
      validateHarnessConfig(validConfig({ harness_version: version })),
      true,
      `harness_version ${version} must be accepted -- the tool stamps its own version here`
    );
  }
  for (const bad of ['1.1', 'v1.1.0', 'latest', '']) {
    assert.throws(
      () => validateHarnessConfig(validConfig({ harness_version: bad })),
      ValidationError,
      `harness_version ${JSON.stringify(bad)} is not a version and must be rejected`
    );
  }
  console.log('✓ harness_version accepts any released semver and rejects non-versions');
}

// 6. The hand-rolled checks still run first, so their messages survive.
{
  assert.throws(
    () => validateScenario(validScenario({ tier: 'gigantic' })),
    (err) => err instanceof ValidationError && err.errors.some((e) => /Invalid scenario tier/.test(e)),
    'Hand-rolled checks must still produce their own messages'
  );
  assert.throws(
    () => validateHarnessConfig(validConfig({ schema_version: '2.0.0' })),
    (err) => err instanceof ValidationError && err.errors.some((e) => /Unsupported schema_version/.test(e)),
    'Hand-rolled schema_version check must still fire first'
  );
  console.log('✓ Hand-rolled checks run first and keep their diagnostics');
}


// 7. The vNext contract-model documents go through the same single path.
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

console.log('All contract schema enforcement tests PASSED.\n');
