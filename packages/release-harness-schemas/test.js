import assert from 'node:assert';
import { Schemas } from './index.js';

console.log('Testing schema definitions...');

assert.ok(Schemas.TopologyV1, 'TopologyV1 should load');
assert.strictEqual(Schemas.TopologyV1.$id, 'https://json.xibo.dev/schemas/release-harness/topology-v1.json');

assert.ok(Schemas.OriginsV1, 'OriginsV1 should load');
assert.ok(Schemas.ScenarioV1, 'ScenarioV1 should load');
assert.ok(Schemas.BrandContractV1, 'BrandContractV1 should load');
assert.ok(Schemas.WaiversV1, 'WaiversV1 should load');
assert.ok(Schemas.EvidenceManifestV1, 'EvidenceManifestV1 should load');
assert.ok(Schemas.VerdictV1, 'VerdictV1 should load');
assert.ok(Schemas.RunManifestV1, 'RunManifestV1 should load');
assert.ok(Schemas.HarnessConfigV1, 'HarnessConfigV1 should load');

// Verify run_integrity enum in VerdictV1
const runIntegrityEnum = Schemas.VerdictV1.properties.run_integrity.enum;
assert.deepStrictEqual(runIntegrityEnum, ['COMPLETE', 'HARNESS_ERROR', 'EVIDENCE_INVALID']);

console.log('All 9 schemas loaded and verified successfully!');
