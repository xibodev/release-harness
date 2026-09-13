import Ajv from 'ajv';
import { Schemas } from '../../release-harness-schemas/index.js';
import { checkContractSemantics } from './contract.js';
import { checkDraft, checkAuthoringRecord } from './draft.js';
import { verifyAcceptedContract } from './acceptance.js';
import { renderSchemaErrors } from './cli/schema-errors.js';

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
    // Rendered for a reader; the raw AJV errors ride along on the exception so
    // --json keeps the structured form. AJV remains the authority on validity --
    // this only decides how the failure is described.
    const raw = validate.errors || [];
    const errors = renderSchemaErrors(raw, label.toLowerCase());
    const err = new ValidationError(
      `${label} failed schema validation`,
      errors.length > 0 ? errors : raw.map((e) => `${e.instancePath || '/'} ${e.message}`)
    );
    err.schemaErrors = raw;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// vNext contract-model documents.
//
// These go through the same path as everything above: schema first, then the
// cross-field rules a schema expresses poorly. The split is deliberate and the
// boundary is stated once -- JSON Schema owns shape, enumerations and per-status
// requirements; runtime owns rules that need to look at more than one place at
// a time (uniqueness across a list, an assertion citing a claim in a different
// file, a digest matching its own content).
//
// What must NOT happen is a rule living in both, drifting, and leaving two
// answers to one question.
// ---------------------------------------------------------------------------

/**
 * Validate an accepted contract: shape, semantics, and that it matches its own
 * digest. The last check is what makes the other two worth doing -- a contract
 * that validates beautifully but has been edited since acceptance is not the
 * contract anyone agreed to.
 */
export function validateAcceptedContract(contract) {
  validateAgainstSchema(Schemas.ContractV1, stripEnvelope(contract), 'Accepted contract');

  const semanticErrors = checkContractSemantics(contract);
  if (semanticErrors.length > 0) {
    throw new ValidationError('Accepted contract failed semantic validation', semanticErrors);
  }

  const verified = verifyAcceptedContract(contract);
  if (!verified.ok) {
    throw new ValidationError(`Accepted contract failed integrity check: ${verified.reason}`, [
      verified.reason,
    ]);
  }

  return true;
}

/**
 * The identity fields of an accepted contract, without its acceptance envelope.
 *
 * `contract-v1.json` describes the proposition, and forbids everything outside
 * it -- which is exactly the invariant that keeps bindings out of identity. An
 * accepted artifact additionally carries its digest and who accepted it, so it
 * is validated as the proposition it contains rather than being rejected for
 * the envelope that makes it useful.
 */
function stripEnvelope(contract) {
  if (!contract || typeof contract !== 'object') return contract;
  const { digest, accepted, ...proposition } = contract;
  return proposition;
}

/**
 * Validate a draft.
 *
 * A draft is allowed to be incomplete -- that is what distinguishes it from a
 * contract, and validating it as one would force an author to fake completeness
 * before they have it. So this checks that a draft is well-formed, never that
 * it is finished.
 */
export function validateDraft(draft) {
  validateAgainstSchema(Schemas.DraftV1, draft, 'Draft');

  const errors = checkDraft(draft);
  if (errors.length > 0) {
    throw new ValidationError('Draft failed semantic validation', errors);
  }
  return true;
}

/**
 * Validate an authoring record.
 *
 * The schema enforces per-status evidence requirements, including the rule that
 * an absence claim must carry its bounds and state that its search completed.
 * Runtime adds what the schema cannot see: that claim ids are unique, since
 * assertions cite claims by id and a duplicate makes that citation ambiguous.
 */
export function validateAuthoringRecord(record) {
  validateAgainstSchema(Schemas.AuthoringRecordV1, record, 'Authoring record');

  const errors = checkAuthoringRecord(record);
  if (errors.length > 0) {
    throw new ValidationError('Authoring record failed semantic validation', errors);
  }
  return true;
}
