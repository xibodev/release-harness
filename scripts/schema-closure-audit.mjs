#!/usr/bin/env node
/**
 * Schema closure audit.
 *
 * Written before any schema was edited, deliberately. The defect this exists to
 * prevent (D14) was not "the proposition object was open" -- it was that I
 * closed the draft root, wrote a test asserting unknown fields were rejected,
 * and the test only ever checked root-level keys. It passed while certifying
 * its own blind spot, and every nested object stayed open.
 *
 * So the invariant is structural: walk every published schema, find every node
 * that describes an object, and require each one to have made a decision.
 * There are exactly two legitimate answers:
 *
 *   closed  - a record of known semantic fields. `additionalProperties: false`.
 *   map     - arbitrary keys ARE the data model (a binding's targets, for
 *             instance). Open on purpose, and annotated to say so.
 *
 * There is no third state. An object that is open because nobody considered it
 * is the state this audit makes impossible to leave behind.
 */

import { Schemas } from '../packages/release-harness-schemas/index.js';

/**
 * Objects whose keys are data rather than schema. Each must justify itself:
 * the reason is recorded here, not in a comment somebody can delete.
 */
const DISCRIMINATED = {
  'DraftV1#/properties/proposition/properties/assertions/items/properties/expect':
    'shape is determined by `kind` and closed per kind by the allOf rules on the assertion',
  'ContractV1#/definitions/assertion/properties/expect':
    'shape is determined by `kind` and closed per kind by the allOf rules on the assertion',
};

const INTENTIONAL_MAPS = {
  'RunManifestV1#/properties/bindings/properties/targets':
    'keys are the symbolic target names an assertion may reference; authored per contract, not enumerable in a schema',
  'RunManifestV1#/properties/sources':
    'keys are subject ids, which are authored per contract',
};

function isObjectNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'object') return true;
  // A node with `properties` is an object whether or not it says so.
  return Boolean(node.properties);
}

/**
 * A conditional branch is a fragment, not a record.
 *
 * `if`/`then`/`else` subschemas constrain an object already described
 * elsewhere -- they add required-ness or narrow a value. Closing one would
 * assert that the branch enumerates every field of the object it applies to,
 * which is false: it deliberately mentions only what it constrains. The
 * closure question belongs to the definition that owns the shape.
 */
function isConditionalFragment(path) {
  return /\/(if|then|else|not)(\/|$)/.test(path);
}

/** Walk a schema, yielding every object-describing node with its path. */
function* objectNodes(node, path = '#') {
  if (!node || typeof node !== 'object') return;

  if (isObjectNode(node)) yield { path, node };

  for (const [key, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue;

    // Skip keywords whose children are not schemas in their own right.
    if (key === 'enum' || key === 'const' || key === 'required') continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        yield* objectNodes(value[i], `${path}/${key}/${i}`);
      }
      continue;
    }

    // `properties` and `definitions` hold named subschemas; everything else
    // (items, then, else, not, additionalProperties-as-schema) is one.
    yield* objectNodes(value, `${path}/${key}`);
  }
}

export function auditClosure() {
  const findings = [];

  for (const [name, schema] of Object.entries(Schemas)) {
    for (const { path, node } of objectNodes(schema, '#')) {
      if (isConditionalFragment(path)) continue;
      const id = `${name}${path}`;
      const closed = node.additionalProperties === false;
      const declaredMap = Object.prototype.hasOwnProperty.call(INTENTIONAL_MAPS, id);
      const discriminated = Object.prototype.hasOwnProperty.call(DISCRIMINATED, id);

      if (discriminated) {
        findings.push({ id, state: 'per-kind', detail: DISCRIMINATED[id] });
        continue;
      }

      if (closed && declaredMap) {
        findings.push({ id, state: 'CONFLICT', detail: 'closed but declared an intentional map' });
      } else if (closed) {
        findings.push({ id, state: 'closed' });
      } else if (declaredMap) {
        findings.push({ id, state: 'map', detail: INTENTIONAL_MAPS[id] });
      } else {
        findings.push({ id, state: 'OPEN', detail: 'no decision recorded' });
      }
    }
  }

  return findings;
}

if (process.argv[1] && process.argv[1].endsWith('schema-closure-audit.mjs')) {
  const findings = auditClosure();
  const open = findings.filter((f) => f.state === 'OPEN');
  const conflict = findings.filter((f) => f.state === 'CONFLICT');

  for (const f of findings) {
    const mark = f.state === 'OPEN' ? '  OPEN     ' : f.state === 'CONFLICT' ? '  CONFLICT ' : `  ${f.state.padEnd(9)}`;
    console.log(`${mark}${f.id}${f.detail ? `  -- ${f.detail}` : ''}`);
  }

  console.log();
  console.log(`${findings.length} object nodes; ${open.length} open, ${conflict.length} conflicting`);
  process.exit(open.length + conflict.length > 0 ? 1 : 0);
}
