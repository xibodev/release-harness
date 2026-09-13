/**
 * Resolving normative references.
 *
 * One read-only authority, consumed by everything that needs to know whether a
 * contract's dependencies are available: the readiness view and the run's
 * eligibility gate.
 *
 * D25 was these being computed in two places. The certifying run built its own
 * resolution map; `doctor` called the readiness check without one, so it could
 * only ever report every reference as unresolved -- including references whose
 * referent was sitting on disk. A readiness command that cannot see an
 * available dependency is worse than one that says nothing, because it teaches
 * the operator to disbelieve it.
 *
 * What this does NOT do is execute anything. Resolution inspects accepted
 * contract identities on disk and nothing else: no assertion runs, no process
 * starts, no binding is touched. `doctor` observes readiness; only `run` acts
 * on it, and only after its gate.
 *
 * And resolution never enters contract identity. Whether a referent happens to
 * be present in this checkout is a fact about the environment, not about the
 * proposition -- which is why the same accepted contract, unchanged, becomes
 * certifiable when its referent later appears.
 */

import fs from 'node:fs';

/**
 * Resolve a contract's normative references against what is accepted here.
 *
 * @param {object|null} contract
 * @param {object} context
 * @param {(digest: string) => string} context.contractPath  where an accepted
 *   contract with this digest would live
 * @param {(file: string) => {found: boolean, value: any, error: string|null}} context.readJson
 *
 * @returns {{
 *   resolved: Record<string, string>,
 *   unresolved: Array<{ref: string, digest: string, reason: string}>,
 *   changed: Array<{ref: string, accepted: string, current: string}>,
 *   allResolved: boolean,
 * }}
 */
export function resolveNormativeReferences(contract, { contractPath, readJson }) {
  const resolved = {};
  const unresolved = [];
  const changed = [];

  for (const req of contract?.requires ?? []) {
    // Resolution is by exact identity, never by name. A contract whose subject
    // happens to share a string with `ref` is not the thing being pinned to --
    // the digest is what was accepted, so the digest is what must be found.
    const byDigest = contractPath(req.digest);
    if (fs.existsSync(byDigest)) {
      const loaded = readJson(byDigest);
      if (loaded.found && !loaded.error && loaded.value?.digest === req.digest) {
        resolved[req.ref] = req.digest;
        continue;
      }
    }

    // A contract stored under the ref's name is how a referenced proposition is
    // found when it has been re-accepted: its digest may now differ, which is
    // the case worth reporting loudly rather than treating as absent.
    const byName = contractPath(req.ref);
    const named = readJson(byName);
    if (named.found && !named.error && typeof named.value?.digest === 'string') {
      if (named.value.digest === req.digest) {
        resolved[req.ref] = req.digest;
      } else {
        resolved[req.ref] = named.value.digest;
        changed.push({ ref: req.ref, accepted: req.digest, current: named.value.digest });
      }
      continue;
    }

    unresolved.push({
      ref: req.ref,
      digest: req.digest,
      reason: 'no accepted contract with that digest is available here',
    });
  }

  return {
    resolved,
    unresolved,
    changed,
    allResolved: unresolved.length === 0 && changed.length === 0,
  };
}
