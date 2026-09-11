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
