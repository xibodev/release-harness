/**
 * `validate` -- check an artifact against the one authority for its type.
 *
 * There is exactly one validation path per artifact, and it lives in core. This
 * command's only job is to work out which artifacts are present and hand each
 * to the right validator, so that a command and a library caller cannot reach
 * two different conclusions about the same file.
 *
 * Each artifact is held to its own standard, which is the part worth stating: a
 * draft is ALLOWED to be incomplete, and checking it as though it were a
 * contract would push an author into faking completeness before they have it.
 */

import { paths, readJson, listDrafts, listAccepted, listBindings, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import {
  validateDraft,
  validateAuthoringRecord,
  validateAcceptedContract,
  ValidationError,
} from '../validator.js';
import { checkAcceptability } from '../draft.js';

/** Run one validator, converting a throw into a reportable result. */
function check(label, fn) {
  try {
    fn();
    return { label, ok: true, errors: [] };
  } catch (err) {
    if (err instanceof ValidationError) return { label, ok: false, errors: err.errors };
    return { label, ok: false, errors: [err.message] };
  }
}

function validateBindingDocument(binding) {
  const errors = [];
  if (!binding || typeof binding !== 'object') {
    errors.push('A binding must be a JSON object');
  } else if (!binding.targets || typeof binding.targets !== 'object' || Array.isArray(binding.targets)) {
    errors.push('A binding must declare a "targets" object mapping symbolic names to locations');
  } else {
    for (const [name, value] of Object.entries(binding.targets)) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`targets.${name} must be a non-empty string`);
      }
    }
    if (Object.keys(binding.targets).length === 0) {
      errors.push('A binding with no targets resolves nothing');
    }
  }
  if (errors.length > 0) throw new ValidationError('Binding validation failed', errors);
}

export function cmdValidate(ctx) {
  const { cwd, out, args } = ctx;

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const results = [];

  // Scope: one named draft, or everything present.
  const draftName = typeof args.flags.draft === 'string' ? args.flags.draft : null;
  const draftNames = draftName ? [draftName] : listDrafts(cwd);

  for (const name of draftNames) {
    const draft = readJson(p.draft(name));
    const record = readJson(p.record(name));

    if (!draft.found) {
      results.push({ label: `draft "${name}"`, ok: false, errors: ['No such draft'] });
      continue;
    }
    if (draft.error) {
      results.push({ label: `draft "${name}"`, ok: false, errors: [draft.error] });
      continue;
    }

    results.push(check(`draft "${name}"`, () => validateDraft(draft.value)));

    if (record.found) {
      if (record.error) {
        results.push({ label: `record "${name}"`, ok: false, errors: [record.error] });
      } else {
        results.push(check(`record "${name}"`, () => validateAuthoringRecord(record.value)));
      }
    } else {
      results.push({
        label: `record "${name}"`,
        ok: false,
        errors: ['No authoring record. Acceptance needs one: it is where the evidence lives.'],
      });
    }
  }

  if (!draftName) {
    for (const digest of listAccepted(cwd)) {
      const contract = readJson(p.contract(digest));
      if (contract.error) {
        results.push({ label: `contract ${digest.slice(0, 12)}…`, ok: false, errors: [contract.error] });
        continue;
      }
      results.push(
        check(`contract ${digest.slice(0, 12)}…`, () => {
          validateAcceptedContract(contract.value);
          // The filename IS the identity, so a mismatch means the file was
          // moved or renamed -- a different failure from an edited body, and
          // worth saying differently.
          if (contract.value.digest !== digest) {
            throw new ValidationError('Contract is stored under the wrong name', [
              `File is named ${digest.slice(0, 12)}… but the contract's digest is ${String(
                contract.value.digest
              ).slice(0, 12)}…`,
            ]);
          }
        })
      );
    }

    for (const name of listBindings(cwd)) {
      const binding = readJson(p.binding(name));
      if (binding.error) {
        results.push({ label: `binding "${name}"`, ok: false, errors: [binding.error] });
        continue;
      }
      results.push(check(`binding "${name}"`, () => validateBindingDocument(binding.value)));
    }
  }

  // Render.
  out.data('results', results);

  if (results.length === 0) {
    out.info('Nothing to validate yet. Create a draft with `release-harness draft new <name>`.');
    return EXIT.OK;
  }

  out.heading('Validation');
  for (const r of results) {
    if (r.ok) {
      out.info(`ok      ${r.label}`);
    } else {
      out.info(`FAILED  ${r.label}`);
      for (const e of r.errors) out.detail(e);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    out.blank();
    out.info(`${failed.length} of ${results.length} failed.`);
    return EXIT.USAGE_OR_CONTRACT;
  }

  // Validity is structural. Saying so plainly is the correction to the defect
  // where a well-formed fabrication was reported as "valid… Ready": a document
  // can satisfy every rule here and still describe software that does not
  // exist, and only a person can close that gap.
  out.blank();
  out.info(`All ${results.length} artifacts are well-formed.`);

  for (const name of draftNames) {
    const draft = readJson(p.draft(name));
    const record = readJson(p.record(name));
    if (!draft.value || !record.value) continue;

    const { acceptable, blockers } = checkAcceptability(draft.value, record.value);
    if (acceptable) {
      out.info(`Draft "${name}" is also ready to accept.`);
    } else {
      out.blank();
      out.info(`Draft "${name}" is well-formed but not ready to accept:`);
      for (const b of blockers) out.detail(`[${b.kind}] ${b.detail}`);
    }
  }

  return EXIT.OK;
}
