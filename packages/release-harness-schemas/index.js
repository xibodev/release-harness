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

/**
 * The published schemas.
 *
 * The lifecycle in order: a draft is proposed, an authoring record says how its
 * claims were arrived at, an accepted contract freezes the proposition, a run
 * manifest records what was exercised and where, evidence is sealed, and a
 * verdict adjudicates.
 *
 * The topology, origins, scenario, brand-contract, waiver and harness-config
 * schemas were removed with the architecture that read them. They described a
 * world where execution bindings and assertions were hashed as one unit, which
 * meant changing a port changed the identity of a promise.
 */
export const Schemas = {
  DraftV1: loadSchema('draft-v1'),
  AuthoringRecordV1: loadSchema('authoring-record-v1'),
  ContractV1: loadSchema('contract-v1'),
  RunManifestV1: loadSchema('run-manifest-v1'),
  EvidenceManifestV1: loadSchema('evidence-manifest-v1'),
  VerdictV1: loadSchema('verdict-v1'),
};

export default Schemas;
