import Ajv from 'ajv';
import { Schemas } from '../../release-harness-schemas/index.js';

/**
 * Lightweight deterministic schema and structure validation for Release Harness documents.
 */

export class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const compiledSchemas = new Map();

/**
 * Validate a document against its published JSON schema.
 *
 * The hand-rolled checks above cover only a subset of each contract, so without
 * this the published schema is documentation: an unsupported service or
 * probe_type would be accepted here and surface much later as a confusing
 * engine failure. Compiled validators are cached per schema object.
 *
 * @throws {ValidationError} when the document does not satisfy the schema.
 */
export function validateAgainstSchema(schema, data, label) {
  if (!schema) {
    throw new ValidationError(`${label} cannot be validated: its published schema is unavailable`, [
      'Missing schema',
    ]);
  }
  let validate = compiledSchemas.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiledSchemas.set(schema, validate);
  }
  if (!validate(data)) {
    const errors = (validate.errors || []).map(
      (e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.allowedValues ? ` (allowed: ${e.params.allowedValues.join('|')})` : ''}`
    );
    throw new ValidationError(`${label} failed schema validation: ${errors.join('; ')}`, errors);
  }
}

function isSupportedSchemaVersion(version) {
  if (!version || typeof version !== 'string') return false;
  // Major version 1.x is supported (1.0.0, 1.0.1, 1.1.0, etc.)
  return /^1\.\d+(\.\d+)?$/.test(version);
}

export function validateHarnessConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    throw new ValidationError('Harness config must be a JSON object', ['Invalid root']);
  }
  if (!isSupportedSchemaVersion(config.schema_version)) {
    errors.push(`Unsupported schema_version "${config.schema_version}". Supported major is 1.x`);
  }
  if (!config.product_slug || typeof config.product_slug !== 'string') {
    errors.push('Missing or invalid "product_slug"');
  }
  if (config.port_block && (typeof config.port_block.start !== 'number' || typeof config.port_block.range !== 'number')) {
    errors.push('Invalid port_block specification (must contain start and range numbers)');
  }
  if (errors.length > 0) {
    throw new ValidationError(`Harness config validation failed with ${errors.length} error(s)`, errors);
  }
  validateAgainstSchema(Schemas.HarnessConfigV1, config, 'Harness config');
  return true;
}

export function validateTopology(topology) {
  const errors = [];
  if (!topology || typeof topology !== 'object') {
    throw new ValidationError('Topology must be a JSON object', ['Invalid root']);
  }
  if (!isSupportedSchemaVersion(topology.schema_version)) {
    errors.push(`Unsupported schema_version "${topology.schema_version}". Supported major is 1.x`);
  }
  if (!topology.product_slug || typeof topology.product_slug !== 'string') {
    errors.push('Missing or invalid "product_slug"');
  }
  if (!['single_repo', 'monorepo', 'multi_repo'].includes(topology.topology_type)) {
    errors.push(`Invalid topology_type "${topology.topology_type}". Expected single_repo|monorepo|multi_repo`);
  }

  if (topology.topology_type === 'multi_repo') {
    if (!Array.isArray(topology.repositories) || topology.repositories.length === 0) {
      errors.push('multi_repo topology requires a non-empty "repositories" array');
    } else {
      for (let i = 0; i < topology.repositories.length; i++) {
        const repo = topology.repositories[i];
        if (!repo.repo_id) errors.push(`Repository at index ${i} missing "repo_id"`);
        if (!repo.source || !repo.source.type || !repo.source.revision_policy) {
          errors.push(`Repository ${repo.repo_id || i} missing valid "source" definition`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(`Topology validation failed with ${errors.length} error(s)`, errors);
  }
  return true;
}

export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== 'object') {
    throw new ValidationError('Scenario must be a JSON object', ['Invalid root']);
  }
  if (!scenario.id || typeof scenario.id !== 'string') errors.push('Missing scenario "id"');
  if (!scenario.name || typeof scenario.name !== 'string') errors.push('Missing scenario "name"');
  if (!scenario.origin_id || typeof scenario.origin_id !== 'string') errors.push('Missing scenario "origin_id"');
  if (!['smoke', 'core', 'full'].includes(scenario.tier)) {
    errors.push(`Invalid scenario tier "${scenario.tier}". Expected smoke|core|full`);
  }
  if (!['required', 'conditional', 'manual', 'unsupported'].includes(scenario.policy)) {
    errors.push(`Invalid scenario policy "${scenario.policy}". Expected required|conditional|manual|unsupported`);
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    errors.push('Scenario must contain a non-empty "steps" array');
  } else {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (!step.action || typeof step.action !== 'string') {
        errors.push(`Step ${i} missing valid "action"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(`Scenario ${scenario.id || 'unknown'} validation failed`, errors);
  }
  validateAgainstSchema(Schemas.ScenarioV1, scenario, `Scenario "${scenario.id}"`);
  return true;
}

export function validateOrigins(origins) {
  const errors = [];
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new ValidationError('Origins contract must be a non-empty array of origins', ['Empty origins']);
  }
  const seenIds = new Set();
  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i];
    if (!origin.origin_id) {
      errors.push(`Origin at index ${i} missing "origin_id"`);
      continue;
    }
    if (seenIds.has(origin.origin_id)) {
      errors.push(`Duplicate origin_id "${origin.origin_id}"`);
    }
    seenIds.add(origin.origin_id);
    if (!['browser_app', 'api', 'worker'].includes(origin.type)) {
      errors.push(`Origin "${origin.origin_id}" invalid type "${origin.type}"`);
    }
    if (!origin.auth) errors.push(`Origin "${origin.origin_id}" missing "auth"`);
    if (!origin.url_source) errors.push(`Origin "${origin.origin_id}" missing "url_source"`);
    if (!Array.isArray(origin.route_families)) errors.push(`Origin "${origin.origin_id}" missing "route_families"`);
    if (!Array.isArray(origin.evidence) || origin.evidence.length === 0) {
      errors.push(`Origin "${origin.origin_id}" must have non-empty "evidence" array`);
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(`Origins contract validation failed with ${errors.length} error(s)`, errors);
  }
  return true;
}

export function validateEvidenceManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    throw new ValidationError('Evidence manifest must be a JSON object', ['Invalid root']);
  }
  if (!isSupportedSchemaVersion(manifest.schema_version)) errors.push('Unsupported schema_version');
  if (!manifest.run_id) errors.push('Missing run_id');
  if (!manifest.sealed_at) errors.push('Missing sealed_at');
  if (!Array.isArray(manifest.files)) errors.push('Missing files array');
  else {
    for (let i = 0; i < manifest.files.length; i++) {
      const f = manifest.files[i];
      if (!f.path || !f.sha256 || typeof f.bytes !== 'number' || !f.category) {
        errors.push(`File at index ${i} has incomplete metadata (path/sha256/bytes/category)`);
      }
    }
  }
  if (errors.length > 0) {
    throw new ValidationError('Evidence manifest validation failed', errors);
  }
  return true;
}

export function validateVerdict(verdict) {
  const errors = [];
  if (!verdict || typeof verdict !== 'object') {
    throw new ValidationError('Verdict must be a JSON object', ['Invalid root']);
  }
  if (!isSupportedSchemaVersion(verdict.schema_version)) errors.push('Unsupported schema_version');
  if (!verdict.run_id) errors.push('Missing run_id');
  if (!['PASS', 'FAIL', 'UNPROVEN'].includes(verdict.certification_status)) {
    errors.push(`Invalid certification_status "${verdict.certification_status}"`);
  }
  if (!['COMPLETE', 'HARNESS_ERROR', 'EVIDENCE_INVALID'].includes(verdict.run_integrity)) {
    errors.push(`Invalid run_integrity "${verdict.run_integrity}"`);
  }
  if (![0, 1, 2, 3, 4].includes(verdict.exit_code)) {
    errors.push(`Invalid exit_code ${verdict.exit_code}`);
  }
  if (!Array.isArray(verdict.causes)) errors.push('Missing causes array');
  if (!Array.isArray(verdict.scenarios)) errors.push('Missing scenarios array');
  if (!verdict.summary || typeof verdict.summary !== 'object') errors.push('Missing summary');
  if (!verdict.evidence_manifest_sha256) errors.push('Missing evidence_manifest_sha256');

  if (errors.length > 0) {
    throw new ValidationError('Verdict validation failed', errors);
  }
  return true;
}
