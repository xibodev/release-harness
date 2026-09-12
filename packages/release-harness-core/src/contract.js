/**
 * The accepted contract: the exact proposition release-harness adjudicates.
 *
 * An accepted contract contains three things and nothing else:
 *
 *   subject     - what is being certified
 *   assertions  - what must hold
 *   requires    - normative references to other subjects whose change would
 *                 alter the meaning of these assertions
 *
 * It deliberately contains no execution bindings (where to run, which port,
 * which URL), no authoring metadata (who proposed it, what was inspected), and
 * no acceptance metadata (who accepted it, when). Those are real and recorded,
 * but they live elsewhere: a proposition's identity must not move because a
 * port changed or because a different person accepted it.
 *
 * The digest identifies the proposition semantically. Two contracts that say
 * the same thing have the same digest regardless of key order, whitespace,
 * number formatting, or unicode representation. A contract that says something
 * different has a different digest. Those two properties are what make a
 * certificate mean anything, so canonicalization is specified here rather than
 * left to `JSON.stringify`.
 */

import crypto from 'node:crypto';
import { Schemas } from '../../release-harness-schemas/index.js';

const AssertionKinds = Schemas.AssertionKindsV1;

export const CONTRACT_SCHEMA_VERSION = '1.0.0';

/**
 * The fields that participate in proposition identity.
 *
 * This is a whitelist, not an ordering: anything not listed here is excluded
 * from the digest by construction rather than by omission, so adding a field to
 * the contract format cannot silently change what identity means. Ordering is
 * uniform — every object is key-sorted, at every depth, including this one.
 */
const IDENTITY_FIELDS = ['schema_version', 'subject', 'assertions', 'requires'];

/**
 * The assertion kinds this version can actually exercise.
 *
 * Declared here, beside the contract semantics, because it is a statement about
 * what a contract may promise -- not an implementation detail of the runner. An
 * adoption agent found the gap it closes: it authored `kind: "process"`, which
 * validated and accepted cleanly and only failed at run time, after the
 * operator had already taken responsibility for a proposition that could never
 * be checked. A promise the harness cannot evaluate should be refused while it
 * is still a draft and still cheap to change.
 */
export const EXECUTABLE_KINDS = ['http', 'cli'];

/**
 * Recursively canonicalize a value.
 *
 * - Objects get their keys sorted, so property order cannot move the digest.
 * - Arrays keep their order, because assertion order is meaningful to a reader
 *   and reordering assertions produces a different-looking proposition. (Order
 *   does not change what is asserted, but stability is cheaper to reason about
 *   than order-insensitivity, and a reordered contract is a contract someone
 *   edited.)
 * - Strings are NFC-normalized, so two unicode spellings of the same text agree.
 * - Numbers are rejected unless finite and integral-safe; floats in a contract
 *   are almost always a mistake and their serialization is not portable.
 * - undefined and functions are rejected rather than silently dropped.
 */
function canonicalizeValue(value, pathHint) {
  if (value === null) return null;

  const t = typeof value;

  if (t === 'string') return value.normalize('NFC');

  if (t === 'boolean') return value;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Contract value at ${pathHint} is not a finite number`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Contract value at ${pathHint} must be a safe integer; fractional and ` +
          'out-of-range numbers do not serialize portably'
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalizeValue(v, `${pathHint}[${i}]`));
  }

  if (t === 'object') {
    // Only plain objects may be canonicalized. A Date, Map, RegExp or class
    // instance is `typeof "object"` but enumerates no own keys, so treating it
    // as a plain object would silently canonicalize it to `{}` -- two contracts
    // holding different Dates would then share a digest. Reject instead.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `Contract value at ${pathHint} has unsupported type ` +
          `"${value.constructor?.name ?? 'object'}"; only plain objects, arrays, ` +
          'strings, booleans, safe integers and null carry portable meaning'
      );
    }

    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue; // absent and explicitly-undefined agree
      out[key] = canonicalizeValue(v, `${pathHint}.${key}`);
    }
    return out;
  }

  throw new TypeError(`Contract value at ${pathHint} has unsupported type "${t}"`);
}

/**
 * Reduce a contract to exactly its identity-bearing fields, key-sorted.
 *
 * Accepts a draft or an accepted contract; any field outside IDENTITY_FIELDS is
 * dropped, which is what lets an accepted artifact carry its own digest without
 * that digest depending on itself.
 *
 * The top level is sorted by the same rule as every nested object, so a
 * reimplementation needs one sentence to describe the canonical form: sort the
 * keys of every object, keep array order, NFC the strings.
 */
export function canonicalizeContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('Contract must be an object');
  }

  const canonical = {};
  for (const field of [...IDENTITY_FIELDS].sort()) {
    if (contract[field] === undefined) continue;
    canonical[field] = canonicalizeValue(contract[field], field);
  }
  return canonical;
}

/**
 * The canonical serialization: compact, sorted, NFC, newline-free.
 *
 * This exact byte sequence is what gets hashed, and it is reproducible by any
 * implementation that follows the rules above — which is the point. A digest
 * nobody else can recompute is not an identity, it is a number.
 */
export function canonicalSerialize(contract) {
  return JSON.stringify(canonicalizeContract(contract));
}

/**
 * The contract digest: sha256 over the canonical serialization.
 */
export function contractDigest(contract) {
  return crypto.createHash('sha256').update(canonicalSerialize(contract), 'utf8').digest('hex');
}

/**
 * Structural checks that JSON Schema expresses poorly or not at all.
 *
 * Schema validation is the authority for shape (see validator); this function
 * covers the cross-field rules a schema cannot state, and returns every problem
 * rather than the first, so an author fixes a draft in one pass.
 */
export function checkContractSemantics(contract) {
  const errors = [];

  if (!contract || typeof contract !== 'object') {
    return ['Contract must be an object'];
  }

  const subject = contract.subject;
  if (!subject || typeof subject !== 'object') {
    errors.push('Contract must declare a "subject"');
  } else {
    if (typeof subject.id !== 'string' || !subject.id.trim()) {
      errors.push('subject.id must be a non-empty string');
    }
    if (subject.name !== undefined && typeof subject.name !== 'string') {
      errors.push('subject.name must be a string when present');
    }
  }

  const assertions = contract.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    errors.push('Contract must declare a non-empty "assertions" array');
  } else {
    const seen = new Set();
    assertions.forEach((a, i) => {
      if (!a || typeof a !== 'object') {
        errors.push(`assertions[${i}] must be an object`);
        return;
      }
      if (typeof a.id !== 'string' || !a.id.trim()) {
        errors.push(`assertions[${i}].id must be a non-empty string`);
      } else if (seen.has(a.id)) {
        errors.push(`Duplicate assertion id "${a.id}"`);
      } else {
        seen.add(a.id);
      }
      if (typeof a.kind !== 'string' || !a.kind.trim()) {
        errors.push(`assertions[${i}] must declare a "kind"`);
      } else if (!EXECUTABLE_KINDS.includes(a.kind)) {
        // Same rule as `checkDraft`, reached by a different door: this function
        // guards the accepted artifact, that one guards the draft. Both read
        // EXECUTABLE_KINDS, so there is one list and one message to maintain,
        // and a caller cannot reach acceptance past a validation that passed.
        errors.push(
          `assertions[${i}] has kind "${a.kind}", which this version cannot exercise ` +
            `(it knows: ${EXECUTABLE_KINDS.join(', ')}). An assertion that cannot be ` +
            'checked is a promise nobody can keep.'
        );
      }
      // An assertion names the thing it exercises symbolically. What that name
      // resolves to at run time is an execution binding, deliberately not here.
      if (typeof a.target !== 'string' || !a.target.trim()) {
        errors.push(`assertions[${i}] must declare a symbolic "target"`);
      }
    });
  }

  const requires = contract.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires)) {
      errors.push('"requires" must be an array when present');
    } else {
      requires.forEach((r, i) => {
        if (!r || typeof r !== 'object') {
          errors.push(`requires[${i}] must be an object`);
          return;
        }
        if (typeof r.ref !== 'string' || !r.ref.trim()) {
          errors.push(`requires[${i}].ref must be a non-empty string`);
        }
        // A normative reference without a digest is a convention, not a
        // reference. This is the C-004 lesson: a cross-subject assumption that
        // nothing pins is exactly what breaks silently in production.
        if (typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest)) {
          errors.push(`requires[${i}].digest must be a sha256 hex digest`);
        }
      });
    }
  }

  return errors;
}

/**
 * The same semantic checks, with machine identity attached.
 *
 * `checkContractSemantics` returns prose, which is what a reader wants and what
 * every existing caller consumes. But two layers can discover the SAME
 * violation -- an assertion with no `kind` is both "incomplete" to acceptability
 * and "must declare a kind" to the contract standard -- and deduplicating those
 * by their wording is brittle: it breaks the moment someone improves a message.
 *
 * So each violation also gets a stable code and a path. Deduplication keys on
 * those, and rendering stays free to change.
 */
export function contractSemanticFindings(contract) {
  const findings = [];
  const at = (code, path, detail, entity) => findings.push({ code, path, detail, entity });

  if (!contract || typeof contract !== 'object') {
    at('CONTRACT_NOT_OBJECT', 'contract', 'Contract must be an object');
    return findings;
  }

  const subject = contract.subject;
  if (!subject || typeof subject !== 'object') {
    at('SUBJECT_MISSING', 'subject', 'Contract must declare a "subject"');
  } else {
    if (typeof subject.id !== 'string' || !subject.id.trim()) {
      // Same semantic violation as checkAcceptability's SUBJECT_ID_MISSING.
      at('SUBJECT_ID_MISSING', 'proposition.subject.id', 'subject.id must be a non-empty string');
    }
    if (subject.name !== undefined && typeof subject.name !== 'string') {
      at('SUBJECT_NAME_TYPE', 'subject.name', 'subject.name must be a string when present');
    }
  }

  const assertions = contract.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    at('ASSERTIONS_EMPTY', 'proposition.assertions', 'Contract must declare a non-empty "assertions" array');
  } else {
    const seen = new Set();
    assertions.forEach((a, i) => {
      if (!a || typeof a !== 'object') {
        at('ASSERTION_NOT_OBJECT', `proposition.assertions[${i}]`, `assertions[${i}] must be an object`);
        return;
      }
      if (typeof a.id !== 'string' || !a.id.trim()) {
        at('ASSERTION_ID_MISSING', `proposition.assertions[${i}].id`, `assertions[${i}].id must be a non-empty string`);
      } else if (seen.has(a.id)) {
        at('ASSERTION_ID_DUPLICATE', `proposition.assertions[${i}].id`, `Duplicate assertion id "${a.id}"`, a.id);
      } else {
        seen.add(a.id);
      }
      if (typeof a.kind !== 'string' || !a.kind.trim()) {
        at('ASSERTION_KIND_MISSING', `proposition.assertions[${i}].kind`, `assertions[${i}] must declare a "kind"`, a.id);
      } else if (!EXECUTABLE_KINDS.includes(a.kind)) {
        // Deliberately a DIFFERENT code from the missing case: an absent kind is
        // unfinished work, an unexecutable one is wrong. Both may apply to the
        // same path and both must survive deduplication.
        at(
          'ASSERTION_KIND_UNSUPPORTED',
          `proposition.assertions[${i}].kind`,
          `assertions[${i}] has kind "${a.kind}", which this version cannot exercise ` +
            `(it knows: ${EXECUTABLE_KINDS.join(', ')}). An assertion that cannot be ` +
            'checked is a promise nobody can keep.',
          a.id
        );
      }
      if (typeof a.target !== 'string' || !a.target.trim()) {
        at('ASSERTION_TARGET_MISSING', `proposition.assertions[${i}].target`, `assertions[${i}] must declare a symbolic "target"`, a.id);
      }
    });
  }

  const requires = contract.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires)) {
      at('REQUIRES_NOT_ARRAY', 'proposition.requires', '"requires" must be an array when present');
    } else {
      requires.forEach((r, i) => {
        if (!r || typeof r !== 'object') {
          at('REQUIRE_NOT_OBJECT', `proposition.requires[${i}]`, `requires[${i}] must be an object`);
          return;
        }
        if (typeof r.ref !== 'string' || !r.ref.trim()) {
          at('REQUIRE_REF_MISSING', `proposition.requires[${i}].ref`, `requires[${i}].ref must be a non-empty string`);
        }
        if (typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest)) {
          at('REQUIRE_DIGEST_INVALID', `proposition.requires[${i}].digest`, `requires[${i}].digest must be a sha256 hex digest`, r.ref);
        }
      });
    }
  }

  return findings;
}

/**
 * The assertion vocabulary, for showing an author.
 *
 * Derived from the published assertion-kind schema -- the same file validation
 * compiles -- so help can never drift from what is enforced. D19 was the
 * opposite: C2 made the vocabulary strict without making it visible, and an
 * adoption agent had to learn `{http, cli}` by deliberately submitting invalid
 * values and reading the rejections.
 *
 * Nothing here restates a field name. If a kind gains an `expect` field, this
 * reports it on the next run with no edit.
 */
export function describeAssertionKinds() {
  const defs = AssertionKinds.definitions ?? {};
  return EXECUTABLE_KINDS.filter((kind) => defs[kind]).map((kind) => ({
    kind,
    description: defs[kind].description ?? '',
    expect: Object.entries(defs[kind].properties ?? {}).map(([field, spec]) => ({
      field,
      description: spec.description ?? '',
    })),
  }));
}
