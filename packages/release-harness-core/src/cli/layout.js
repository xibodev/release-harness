/**
 * Where things live on disk, and what each location means.
 *
 * The layout is part of the product, not an implementation detail. Someone
 * looking at the directory has to be able to see the boundary between what is
 * still being worked out and what has been committed to, without reading any
 * documentation and without running anything.
 *
 *   .release-harness/
 *     config.json                       harness-owned settings, nothing about your product
 *     drafts/<name>.draft.json          mutable: a proposal, edit freely
 *     drafts/<name>.record.json         mutable: how its claims were arrived at
 *     accepted/<digest>.contract.json   immutable: the name IS the identity
 *     accepted/<digest>.acceptance.json append-only: who accepted that digest, and when
 *     bindings/<name>.binding.json      where to go and look; not part of any promise
 *     runs/<run-id>/manifest.json       what was exercised, where, and what came of it
 *     runs/<run-id>/verdict.json        the adjudication
 *     runs/<run-id>/evidence/           sealed observations
 *
 * Two properties are doing the work.
 *
 * An accepted contract is named by its own digest. It cannot be edited in place
 * in any meaningful sense -- change a byte and the file no longer matches the
 * name it is stored under, which `verify` reports. Nothing anywhere says
 * `accepted: true`, because a flag in a mutable file is not a boundary: anyone
 * can set it, anyone can edit the file afterwards, and nothing notices that the
 * accepted thing and the current thing have diverged.
 *
 * And acceptance metadata lives beside the contract rather than inside it.
 * The same proposition accepted twice by two people on two days is one
 * proposition with two acceptance events, so the events accumulate in their own
 * file and the contract itself never changes.
 */

import fs from 'node:fs';
import path from 'node:path';

export const HARNESS_DIR = '.release-harness';

export const DIRS = {
  drafts: 'drafts',
  accepted: 'accepted',
  bindings: 'bindings',
  runs: 'runs',
  reviews: 'reviews',
};

export function harnessRoot(cwd) {
  return path.join(cwd, HARNESS_DIR);
}

export function paths(cwd) {
  const root = harnessRoot(cwd);
  return {
    root,
    config: path.join(root, 'config.json'),
    drafts: path.join(root, DIRS.drafts),
    accepted: path.join(root, DIRS.accepted),
    bindings: path.join(root, DIRS.bindings),
    runs: path.join(root, DIRS.runs),
    reviews: path.join(root, DIRS.reviews),
    confirmedReviews: path.join(root, DIRS.reviews, 'confirmed'),
    draft: (name) => path.join(root, DIRS.drafts, `${name}.draft.json`),
    record: (name) => path.join(root, DIRS.drafts, `${name}.record.json`),
    contract: (digest) => path.join(root, DIRS.accepted, `${digest}.contract.json`),
    acceptance: (digest) => path.join(root, DIRS.accepted, `${digest}.acceptance.json`),
    binding: (name) => path.join(root, DIRS.bindings, `${name}.binding.json`),
    run: (runId) => path.join(root, DIRS.runs, runId),
    review: (name) => path.join(root, DIRS.reviews, `${name}.review.json`),
    confirmedReview: (digest) => path.join(root, DIRS.reviews, 'confirmed', `${digest}.review.json`),
    reviewConfirmation: (digest) => path.join(root, DIRS.reviews, 'confirmed', `${digest}.confirmation.json`),
  };
}

export function isInstalled(cwd) {
  return fs.existsSync(paths(cwd).config);
}

/** Read JSON, distinguishing "absent" from "unparseable". */
export function readJson(file) {
  if (!fs.existsSync(file)) return { found: false, value: null, error: null };
  try {
    return { found: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (err) {
    return { found: true, value: null, error: `${path.basename(file)} is not valid JSON: ${err.message}` };
  }
}

/**
 * Write JSON pretty-printed, because a human is going to read and edit these.
 * Nothing downstream may depend on this formatting; that is what canonical
 * serialization is for.
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** List the draft names present, by their draft file. */
export function listDrafts(cwd) {
  const dir = paths(cwd).drafts;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.draft.json'))
    .map((f) => f.slice(0, -'.draft.json'.length))
    .sort();
}

/** List the accepted contract digests present. */
export function listAccepted(cwd) {
  const dir = paths(cwd).accepted;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.contract.json'))
    .map((f) => f.slice(0, -'.contract.json'.length))
    .sort();
}

export function listBindings(cwd) {
  const dir = paths(cwd).bindings;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.binding.json'))
    .map((f) => f.slice(0, -'.binding.json'.length))
    .sort();
}


export function listReviews(cwd) {
  const dir = paths(cwd).reviews;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.review.json'))
    .map((f) => f.slice(0, -'.review.json'.length))
    .sort();
}

export function listConfirmedReviews(cwd) {
  const dir = paths(cwd).confirmedReviews;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.review.json'))
    .map((f) => f.slice(0, -'.review.json'.length))
    .sort();
}

/**
 * Resolve which accepted contract a command means.
 *
 * A digest prefix is accepted because nobody types 64 hex characters, but an
 * ambiguous prefix is an error rather than a guess: picking one of two
 * candidate propositions on the user's behalf is exactly the class of silent
 * decision this project exists to eliminate.
 */
export function resolveAccepted(cwd, ref) {
  const digests = listAccepted(cwd);
  if (digests.length === 0) return { ok: false, reason: 'No accepted contract exists.' };

  if (!ref) {
    if (digests.length === 1) return { ok: true, digest: digests[0] };
    return {
      ok: false,
      reason:
        `${digests.length} accepted contracts exist; name one.\n` +
        digests.map((d) => `  ${d.slice(0, 12)}â€¦`).join('\n'),
    };
  }

  const matches = digests.filter((d) => d.startsWith(ref));
  if (matches.length === 1) return { ok: true, digest: matches[0] };
  if (matches.length === 0) return { ok: false, reason: `No accepted contract matches "${ref}".` };
  return {
    ok: false,
    reason:
      `"${ref}" matches ${matches.length} accepted contracts; be more specific.\n` +
      matches.map((d) => `  ${d.slice(0, 16)}â€¦`).join('\n'),
  };
}
