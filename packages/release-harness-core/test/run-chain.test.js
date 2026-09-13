// Bindings, the eligibility gate, and the verification chain.
//
// Three properties, all of which the shipped harness gets wrong:
//
//   G-*  Eligibility is decided before any side effect, and an unaccepted
//        proposition can never certify. This is the invariant the self-adoption
//        fixture violated.
//   B-*  Bindings are a sibling of the contract, never folded into it: changing
//        a port must not look like changing a promise.
//   V-*  Every recorded hash is actually read back. The research found
//        `verdict_sha256` and `config_hashes` written and never verified, which
//        is worse than no hash at all -- it invites trust it has not earned.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBindings, bindingDigest, decideMode, describeReadiness, INELIGIBLE } from '../src/bindings.js';
import { buildRunManifest, verifyRunManifest, artifactDigest } from '../src/run-manifest.js';
import { acceptDraft } from '../src/acceptance.js';
import { MODE } from '../src/attribution.js';
import { EvidenceSealer } from '../src/sealer.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nBindings, eligibility and the verification chain\n');

const draft = () => ({
  schema_version: '1.0.0',
  proposition: {
    subject: { id: 'checkout-service' },
    assertions: [
      { id: 'A1', kind: 'http', target: 'api', expect: { status: 200 }, supported_by: ['c1'] },
    ],
  },
});
const record = () => ({
  schema_version: '1.0.0',
  claims: [{ id: 'c1', claim: 'api serves /health', status: 'observed', evidence: { source: 'compose.yml:4' } }],
});
const accept = (d = draft()) => acceptDraft(d, record(), { by: 'op', at: '2026-09-11T00:00:00Z' });

const localBindings = { targets: { api: 'http://127.0.0.1:3000' } };
const ciBindings = { targets: { api: 'https://staging.example.com' } };

// ---------------------------------------------------------------------------
// B-1  Bindings resolve symbolic targets and are identified separately.
// ---------------------------------------------------------------------------
{
  const contract = accept();

  const local = resolveBindings(contract, localBindings);
  assert.strictEqual(local.ok, true, 'a complete binding set resolves');
  assert.strictEqual(local.resolved.api, 'http://127.0.0.1:3000', 'the symbolic target resolves');

  const missing = resolveBindings(contract, { targets: {} });
  assert.strictEqual(missing.ok, false, 'a missing binding must not silently resolve');
  assert.deepStrictEqual(missing.unresolved, ['api'], 'and must name what is unbound');

  // The two identities move independently: that is the whole separation.
  assert.notStrictEqual(
    bindingDigest(localBindings),
    bindingDigest(ciBindings),
    'different bindings must have different binding identities'
  );
  assert.strictEqual(
    accept().digest,
    contract.digest,
    'while the proposition keeps one identity regardless'
  );

  pass('B-1', 'bindings resolve symbolic targets and carry their own identity');
}

// ---------------------------------------------------------------------------
// G-1  An accepted contract with resolvable bindings certifies.
// ---------------------------------------------------------------------------
{
  const decision = decideMode(accept(), localBindings);

  assert.strictEqual(decision.mode, MODE.CERTIFYING, 'an accepted, bound contract may certify');
  assert.strictEqual(decision.eligible, true, 'and is eligible');
  assert.deepStrictEqual(decision.reasons, [], 'with nothing standing in the way');

  pass('G-1', 'an accepted contract with resolvable bindings certifies');
}

// ---------------------------------------------------------------------------
// G-2  An unaccepted proposition can never certify.
//
// This is the invariant the self-adoption fixture violated. Running is fine --
// that is how an author learns whether their proposition survives contact with
// the software. Certifying is not.
// ---------------------------------------------------------------------------
{
  const none = decideMode(null, localBindings);
  assert.strictEqual(none.mode, MODE.EXPLORATORY, 'no contract means no certification');
  assert.ok(
    none.reasons.some((r) => r.code === INELIGIBLE.NO_CONTRACT),
    'and the reason must say so'
  );

  // A draft's proposition, run directly, is still not an accepted contract.
  const unaccepted = { ...draft().proposition, schema_version: '1.0.0' };
  const raw = decideMode(unaccepted, localBindings);
  assert.strictEqual(raw.mode, MODE.EXPLORATORY, 'an undigested proposition cannot certify');
  assert.ok(
    raw.reasons.some((r) => r.code === INELIGIBLE.CONTRACT_NOT_ACCEPTED),
    'and must be identified as unaccepted, not merely invalid'
  );

  // Ineligibility is never an error: the run proceeds, it just cannot certify.
  assert.ok(Array.isArray(raw.reasons), 'ineligibility is reported, not thrown');

  pass('G-2', 'an unaccepted proposition runs but never certifies');
}

// ---------------------------------------------------------------------------
// G-3  A tampered contract, an unbound target, or a moved normative reference
//      each block certification -- and every reason is reported at once.
// ---------------------------------------------------------------------------
{
  const tampered = JSON.parse(JSON.stringify(accept()));
  tampered.assertions[0].expect.status = 500;
  assert.ok(
    decideMode(tampered, localBindings).reasons.some((r) => r.code === INELIGIBLE.CONTRACT_TAMPERED),
    'a contract edited after acceptance must not certify'
  );

  assert.ok(
    decideMode(accept(), { targets: {} }).reasons.some(
      (r) => r.code === INELIGIBLE.BINDINGS_UNRESOLVED
    ),
    'an assertion whose target does not resolve cannot be exercised'
  );

  // A normative reference that has moved means the contract was accepted
  // against a proposition that no longer exists -- the cross-repo failure this
  // project exists to catch.
  const d1 = 'a'.repeat(64);
  const d2 = 'b'.repeat(64);
  const withRef = draft();
  withRef.proposition.requires = [{ ref: 'usage-schema', digest: d1 }];
  const refContract = accept(withRef);

  assert.strictEqual(
    decideMode(refContract, localBindings, { resolvedRefs: { 'usage-schema': d1 } }).eligible,
    true,
    'an unchanged normative reference is fine'
  );

  const moved = decideMode(refContract, localBindings, { resolvedRefs: { 'usage-schema': d2 } });
  assert.strictEqual(moved.eligible, false, 'a moved normative reference blocks certification');
  assert.ok(
    moved.reasons.some((r) => r.code === INELIGIBLE.NORMATIVE_REF_CHANGED),
    'and must be reported as changed, not merely unresolved'
  );

  const unresolvable = decideMode(refContract, localBindings, { resolvedRefs: {} });
  assert.ok(
    unresolvable.reasons.some((r) => r.code === INELIGIBLE.NORMATIVE_REF_UNRESOLVED),
    'an unresolvable reference is unknown, not assumed current'
  );

  // Several problems at once must all surface.
  const everything = decideMode(tampered, { targets: {} });
  assert.ok(everything.reasons.length >= 2, 'every blocking reason must be reported at once');

  pass('G-3', 'tampering, unbound targets and moved references each block certification');
}

// ---------------------------------------------------------------------------
// G-4  Readiness is a set of independent facts, never one summary flag.
//
// The decisive bug in the self-adoption fixture: `doctor` enumerated three
// absent contracts and printed "Status: Ready." Every individual fact was true;
// the summary was false, and the summary was the only part anyone read.
// ---------------------------------------------------------------------------
{
  const bare = describeReadiness({ contract: null, bindings: {} });

  assert.strictEqual(bare.contract_present, false, 'the absence of a contract is a reported fact');
  assert.strictEqual(bare.certification_eligible, false, 'and eligibility is its own fact');
  assert.ok(bare.reasons.length > 0, 'with reasons attached');

  // No aggregate "ready" anywhere -- a caller must decide what it is claiming.
  assert.ok(
    !('ready' in bare) && !('ok' in bare) && !('status' in bare),
    'readiness must not collapse into a single flag someone can read instead of the facts'
  );

  const good = describeReadiness({ contract: accept(), bindings: localBindings });
  assert.deepStrictEqual(
    good,
    {
      contract_present: true,
      contract_accepted: true,
      contract_intact: true,
      bindings_resolvable: true,
      normative_refs_current: true,
      certification_eligible: true,
      reasons: [],
    },
    'a ready installation reports each fact independently'
  );

  pass('G-4', 'readiness is independent facts, with no aggregate flag to misread');
}

// ---------------------------------------------------------------------------
// V-1  The run manifest keeps the four identities apart.
// ---------------------------------------------------------------------------
{
  const contract = accept();
  const verdict = { status: 'PASS', assertions: [{ id: 'A1', status: 'PASS' }] };

  const common = {
    runId: 'run-1',
    contract,
    sources: { 'checkout-service': 'git:abc123' },
    evidenceManifestSha256: 'e'.repeat(64),
    verdict,
    mode: MODE.CERTIFYING,
  };

  const local = buildRunManifest({ ...common, bindings: localBindings });
  const ci = buildRunManifest({ ...common, runId: 'run-2', bindings: ciBindings });

  assert.strictEqual(
    local.contract.digest,
    ci.contract.digest,
    'one proposition exercised in two places keeps one contract identity'
  );
  assert.notStrictEqual(
    local.bindings.digest,
    ci.bindings.digest,
    'while the binding identity differs'
  );
  assert.ok(local.sources && local.bindings && local.evidence && local.verdict, 'four separate identities');
  assert.strictEqual(local.certification.mode, MODE.CERTIFYING, 'eligibility is recorded on the manifest');

  // An exploratory run must be legible as such after the fact.
  const exploratory = buildRunManifest({
    ...common,
    contract: null,
    bindings: localBindings,
    mode: MODE.EXPLORATORY,
    ineligibleReasons: [{ code: INELIGIBLE.NO_CONTRACT, detail: 'no contract' }],
  });
  assert.strictEqual(exploratory.contract, null, 'an exploratory run cites no contract');
  assert.strictEqual(exploratory.certification.eligible, false, 'and is marked ineligible');
  assert.ok(exploratory.certification.ineligible_reasons.length > 0, 'with the reason retained');

  pass('V-1', 'the run manifest keeps contract, bindings, source and evidence apart');
}

// ---------------------------------------------------------------------------
// V-2  Every recorded hash is read back.
//
// The research found `verdict_sha256` and `config_hashes` written and never
// verified by anything. A hash nobody checks looks like a guarantee and is not
// one, so the chain is walked here end to end against real sealed evidence.
// ---------------------------------------------------------------------------
{
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-ev-'));
  const sealer = new EvidenceSealer(evidenceDir, 'run-chain');
  sealer.writeEvidence('probes/health.json', '{"status":200}\n');
  const sealed = sealer.sealEvidence();

  const contract = accept();
  const verdict = { status: 'PASS', assertions: [{ id: 'A1', status: 'PASS' }] };

  const manifest = buildRunManifest({
    runId: 'run-chain',
    contract,
    bindings: localBindings,
    sources: { 'checkout-service': 'git:abc123' },
    evidenceManifestSha256: sealed.manifestSha256,
    verdict,
    mode: MODE.CERTIFYING,
  });

  const intact = verifyRunManifest(manifest, { contract, verdict, sealer });
  assert.strictEqual(intact.ok, true, 'an intact chain must verify');
  assert.deepStrictEqual(
    [...intact.checked].sort(),
    ['contract', 'evidence', 'verdict'],
    'and every link must actually have been checked'
  );

  // Each link, broken independently.
  const editedVerdict = { ...verdict, status: 'FAIL' };
  assert.ok(
    verifyRunManifest(manifest, { contract, verdict: editedVerdict, sealer }).broken.some(
      (b) => b.link === 'verdict'
    ),
    'an edited verdict must be detected -- this is the hash that was never read back'
  );

  const editedContract = JSON.parse(JSON.stringify(contract));
  editedContract.assertions[0].expect.status = 500;
  assert.ok(
    verifyRunManifest(manifest, { contract: editedContract, verdict, sealer }).broken.some(
      (b) => b.link === 'contract'
    ),
    'a contract edited after the run must be detected'
  );

  fs.writeFileSync(path.join(evidenceDir, 'probes', 'health.json'), '{"status":500}\n');
  assert.ok(
    verifyRunManifest(manifest, { contract, verdict, sealer }).broken.some(
      (b) => b.link === 'evidence'
    ),
    'mutated evidence must break the chain'
  );

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  pass('V-2', 'the chain is walked end to end and every recorded hash is read back');
}

// ---------------------------------------------------------------------------
// V-3  A link that cannot be checked is reported unchecked, never passed.
//
// "I could not verify this" and "this is fine" are the two statements this
// project exists to keep apart.
// ---------------------------------------------------------------------------
{
  const contract = accept();
  const verdict = { status: 'PASS' };
  const manifest = buildRunManifest({
    runId: 'run-partial',
    contract,
    bindings: localBindings,
    evidenceManifestSha256: 'f'.repeat(64),
    verdict,
    mode: MODE.CERTIFYING,
  });

  const partial = verifyRunManifest(manifest, {});
  assert.strictEqual(partial.ok, true, 'nothing is BROKEN when nothing could be checked');
  assert.deepStrictEqual(partial.checked, [], 'but nothing is claimed as checked either');
  assert.deepStrictEqual(
    [...partial.unchecked.map((u) => u.link)].sort(),
    ['contract', 'evidence', 'verdict'],
    'every unverifiable link must be reported as unchecked'
  );

  // A manifest claiming eligibility while citing no contract is the shape a
  // forged certificate would take, and is broken rather than merely unchecked.
  const forged = { ...manifest, contract: null };
  assert.ok(
    verifyRunManifest(forged, {}).broken.some((b) => b.link === 'certification'),
    'a certificate citing no contract must be rejected outright'
  );

  // Substituting a different contract is caught even though both are valid.
  const otherDraft = draft();
  otherDraft.proposition.subject.id = 'other-service';
  assert.ok(
    verifyRunManifest(manifest, { contract: accept(otherDraft) }).broken.some(
      (b) => b.link === 'contract' && /not the one this run certified/.test(b.detail)
    ),
    'a valid but different contract must not satisfy the manifest'
  );

  pass('V-3', 'unverifiable links are reported unchecked, and forgery is rejected');
}

// ---------------------------------------------------------------------------
// V-4  Artifact digests ignore serialization accidents.
// ---------------------------------------------------------------------------
{
  const a = { status: 'PASS', assertions: [{ id: 'A1', status: 'PASS' }] };
  const b = { assertions: [{ status: 'PASS', id: 'A1' }], status: 'PASS' };

  assert.strictEqual(artifactDigest(a), artifactDigest(b), 'key order must not move a digest');
  assert.notStrictEqual(
    artifactDigest(a),
    artifactDigest({ ...a, status: 'FAIL' }),
    'a changed verdict must move its digest'
  );

  pass('V-4', 'artifact digests survive reserialization and catch real changes');
}

console.log(`\n  ${results.length} binding, eligibility and chain checks passed\n`);
