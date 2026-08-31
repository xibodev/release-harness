import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, 'schemas');

export function loadSchema(name) {
  const file = path.join(SCHEMAS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Schema not found: ${name} (${file})`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const Schemas = {
  TopologyV1: loadSchema('topology-v1'),
  OriginsV1: loadSchema('origins-v1'),
  ScenarioV1: loadSchema('scenario-v1'),
  BrandContractV1: loadSchema('brand-contract-v1'),
  WaiversV1: loadSchema('waivers-v1'),
  EvidenceManifestV1: loadSchema('evidence-manifest-v1'),
  VerdictV1: loadSchema('verdict-v1'),
  RunManifestV1: loadSchema('run-manifest-v1'),
  HarnessConfigV1: loadSchema('harness-config-v1'),
};

export default Schemas;
