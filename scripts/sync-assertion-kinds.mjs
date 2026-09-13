/**
 * One vocabulary, three schemas.
 *
 * D44: `assertion-kinds-v1.json` calls itself "the single definition shared by
 * the draft schema, the contract schema and the execution adapter". It was not.
 * The draft and contract schemas each carried their own hand-copied `expect`
 * rules, so adding `body_contains` and `stderr_contains` to the kinds schema
 * and to the executor left both validators rejecting them -- while the CLI,
 * which derives its help from the kinds schema, cheerfully taught authors to
 * write fields that could not validate.
 *
 * An adoption run hit it within minutes and called it precisely: "the tool's
 * own help teaches two fields that validation rejects".
 *
 * This is the D9/D14 class -- a fix applied to one of several places -- and the
 * fix is the same as it was there: stop synchronising copies, and derive them.
 * The kinds schema is the authority; the per-kind `if/then` branches in the
 * draft and contract schemas are generated from it.
 *
 * Run: node scripts/sync-assertion-kinds.mjs [--check]
 *   --check exits non-zero if a generated block is stale, for the gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(HERE, '..', 'packages', 'release-harness-schemas', 'schemas');

const KINDS = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'assertion-kinds-v1.json'), 'utf8'));

/** The generated `if/then` branch constraining `expect` for one kind. */
function branchFor(kind) {
  const def = KINDS.definitions[kind];
  if (!def) throw new Error(`assertion-kinds-v1 has no definition for "${kind}"`);
  return {
    description: `An assertion of kind "${kind}" may only expect what the ${kind} adapter reads.`,
    if: { properties: { kind: { const: kind } }, required: ['kind'] },
    then: {
      properties: {
        // Structural clone of the authority. Anything else is a second copy.
        expect: JSON.parse(JSON.stringify(def)),
      },
    },
  };
}

/**
 * Replace the per-kind branches inside a schema's assertion `allOf`.
 *
 * Only branches that discriminate on `kind` are touched; any other rule in the
 * same `allOf` is left exactly as authored.
 */
function regenerate(schema, locate) {
  const allOf = locate(schema);
  if (!Array.isArray(allOf)) throw new Error('expected an allOf array of assertion rules');

  const kinds = Object.keys(KINDS.definitions);
  const kept = allOf.filter((rule) => {
    const k = rule?.if?.properties?.kind?.const;
    return !(typeof k === 'string' && kinds.includes(k));
  });

  return [...kept, ...kinds.map(branchFor)];
}

const TARGETS = [
  {
    file: 'draft-v1.json',
    locate: (s) => s.properties.proposition.properties.assertions.items.allOf,
    assign: (s, v) => {
      s.properties.proposition.properties.assertions.items.allOf = v;
    },
  },
  {
    file: 'contract-v1.json',
    // The contract reaches its assertion rules through a $ref, so the branches
    // live in definitions rather than inline under items.
    locate: (s) => s.definitions.assertion.allOf,
    assign: (s, v) => {
      s.definitions.assertion.allOf = v;
    },
  },
];

const check = process.argv.includes('--check');
let stale = [];

for (const target of TARGETS) {
  const file = path.join(SCHEMAS, target.file);
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));

  const before = JSON.stringify(target.locate(schema));
  const regenerated = regenerate(schema, target.locate);
  const after = JSON.stringify(regenerated);

  if (before === after) continue;

  if (check) {
    stale.push(target.file);
    continue;
  }

  target.assign(schema, regenerated);
  fs.writeFileSync(file, JSON.stringify(schema, null, 2) + '\n');
  console.log(`  regenerated assertion rules in ${target.file}`);
}

if (check && stale.length) {
  console.error(
    `Assertion rules are stale in: ${stale.join(', ')}\n` +
      `Run: node scripts/sync-assertion-kinds.mjs`
  );
  process.exit(1);
}

if (!check) console.log('  assertion vocabulary is one definition, derived everywhere');
