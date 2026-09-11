/**
 * The run manifest: what was exercised, where, and what came of it.
 *
 * A verdict on its own is an assertion by the harness. The manifest is what
 * makes it checkable, by binding together the four identities a reader needs to
 * reconstruct what happened:
 *
 *   contract    - which proposition (and the digests of what it depends on)
 *   bindings    - where it was exercised, which is NOT part of the proposition
 *   source      - which revision of the subject
 *   evidence    - what was observed, sealed
 *
 * They are separate fields rather than one combined hash because they answer
 * different questions and change independently. The current code hashes the
 * proposition together with its bindings, so "did the promise change?" and "did
 * the port change?" are indistinguishable afterwards -- which makes the digest
 * useless for the thing a digest is for.
 *
 * The research found the sharper version of this problem: `verdict_sha256` and
 * `config_hashes` are written by the current harness and never read back by
 * anything. A hash nobody verifies is a decoration that looks like a guarantee,
 * and it is worse than no hash at all, because it invites trust it has not
 * earned. So this module ships `verifyRunManifest`, and the chain it walks is
 * tested end to end.
 */

import crypto from 'node:crypto';
import { verifyAcceptedContract } from './acceptance.js';
import { bindingDigest } from './bindings.js';
import { MODE } from './attribution.js';

export const RUN_MANIFEST_SCHEMA_VERSION = '1.0.0';

/** Stable digest of any artifact, over its sorted canonical JSON. */
function digestOf(value) {
  const canonical = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canonical);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = canonical(v[k]);
    }
    return out;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export { digestOf as artifactDigest };

/**
 * Build the manifest for a completed run.
 *
 * @param {object}      args
 * @param {string}      args.runId
 * @param {object|null} args.contract        The accepted contract, if any.
 * @param {object}      args.bindings        Where this run looked.
 * @param {object}      [args.sources]       Subject revisions, by id.
 * @param {string}      args.evidenceManifestSha256  From the sealer.
 * @param {object}      args.verdict         The adjudication result.
 * @param {string}      args.mode            CERTIFYING or EXPLORATORY.
 * @param {Array}       [args.ineligibleReasons]  Why it could not certify.
 */
export function buildRunManifest({
  runId,
  contract = null,
  bindings = {},
  sources = {},
  evidenceManifestSha256,
  verdict,
  mode,
  ineligibleReasons = [],
  startedAt,
  completedAt,
}) {
  if (!runId) throw new TypeError('A run manifest requires a run id');
  if (!mode) throw new TypeError('A run manifest requires an explicit mode');
  if (typeof evidenceManifestSha256 !== 'string') {
    throw new TypeError('A run manifest requires the sealed evidence manifest digest');
  }

  const manifest = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    run_id: runId,

    // What was promised. `null` is meaningful: an exploratory run genuinely has
    // no accepted proposition, and recording an empty digest would suggest one.
    contract: contract
      ? {
          digest: contract.digest,
          subject_id: contract.subject?.id,
          // Resolved as of this run. If one of these has moved since acceptance
          // the run was not eligible to certify, and the manifest records both
          // the accepted digest and that fact.
          requires: (contract.requires ?? []).map((r) => ({ ref: r.ref, digest: r.digest })),
        }
      : null,

    // Where it was exercised. Deliberately a sibling of `contract`, never
    // folded into it: changing a port must not look like changing a promise.
    bindings: {
      digest: bindingDigest(bindings),
      targets: bindings?.targets ?? {},
    },

    // Which revision of the subject. Separate again, because the same
    // proposition against two commits is two runs, not two propositions.
    sources,

    evidence: { manifest_sha256: evidenceManifestSha256 },

    // Recorded on the manifest so that eligibility is auditable after the fact.
    // A reader must be able to tell a certificate from a dry run without
    // reconstructing the conditions that produced it.
    certification: {
      mode,
      eligible: mode === MODE.CERTIFYING,
      ...(ineligibleReasons.length > 0 ? { ineligible_reasons: ineligibleReasons } : {}),
    },

    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
  };

  // The verdict digest is computed over the verdict itself and stored beside
  // it, so tampering with either is detectable. This is the hash the research
  // found written and never read -- `verifyRunManifest` below reads it.
  manifest.verdict = { digest: digestOf(verdict), status: verdict?.status };

  return manifest;
}

/**
 * Walk the whole chain and report every break.
 *
 * contract → run manifest → evidence → verdict
 *
 * Each link is checked against the artifact it claims to describe. A caller
 * supplies whichever artifacts it holds; a link that cannot be checked is
 * reported as unchecked rather than passed, because "I could not verify this"
 * and "this is fine" are the two statements this project exists to keep apart.
 *
 * @param {object} manifest
 * @param {object} [held]
 * @param {object} [held.contract] The accepted contract the manifest cites.
 * @param {object} [held.verdict]  The verdict the manifest cites.
 * @param {object} [held.sealer]   Anything with verifyIntegrity(), e.g. an
 *   EvidenceSealer pointed at the run's evidence directory.
 */
export function verifyRunManifest(manifest, held = {}) {
  const broken = [];
  const unchecked = [];
  const checked = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, broken: [{ link: 'manifest', detail: 'Run manifest is not an object' }], unchecked, checked };
  }

  // --- contract → manifest -------------------------------------------------
  if (manifest.contract) {
    if (!held.contract) {
      unchecked.push({
        link: 'contract',
        detail: `Manifest cites contract ${manifest.contract.digest?.slice(0, 12)}…, which was not supplied.`,
      });
    } else {
      const verified = verifyAcceptedContract(held.contract);
      if (!verified.ok) {
        broken.push({ link: 'contract', detail: verified.reason });
      } else if (verified.digest !== manifest.contract.digest) {
        broken.push({
          link: 'contract',
          detail:
            'The supplied contract is not the one this run certified: it says ' +
            `${verified.digest.slice(0, 12)}…, the manifest cites ` +
            `${manifest.contract.digest?.slice(0, 12)}….`,
        });
      } else {
        checked.push('contract');
      }
    }
  } else if (manifest.certification?.eligible) {
    // A manifest claiming eligibility with no contract is self-contradictory,
    // and it is the shape a forged certificate would take.
    broken.push({
      link: 'certification',
      detail: 'The manifest claims certification eligibility but cites no accepted contract.',
    });
  }

  // --- evidence ------------------------------------------------------------
  if (held.sealer && typeof held.sealer.verifyIntegrity === 'function') {
    const integrity = held.sealer.verifyIntegrity();
    if (!integrity.ok) {
      broken.push({
        link: 'evidence',
        detail:
          'Sealed evidence does not verify: ' +
          [
            integrity.missingFiles?.length ? `${integrity.missingFiles.length} missing` : null,
            integrity.modifiedFiles?.length ? `${integrity.modifiedFiles.length} modified` : null,
            integrity.unexpectedFiles?.length ? `${integrity.unexpectedFiles.length} unexpected` : null,
          ]
            .filter(Boolean)
            .join(', ') || integrity.error,
      });
    } else if (integrity.manifestSha256 !== manifest.evidence?.manifest_sha256) {
      broken.push({
        link: 'evidence',
        detail:
          'The evidence on disk is sealed and intact, but it is not the evidence ' +
          'this manifest describes -- the manifest digests do not match.',
      });
    } else {
      checked.push('evidence');
    }
  } else {
    unchecked.push({
      link: 'evidence',
      detail: 'No evidence directory was supplied, so sealed evidence was not verified.',
    });
  }

  // --- verdict -------------------------------------------------------------
  if (held.verdict) {
    const actual = digestOf(held.verdict);
    if (actual !== manifest.verdict?.digest) {
      broken.push({
        link: 'verdict',
        detail:
          'The verdict does not match its recorded digest: it was edited after the run.',
      });
    } else {
      checked.push('verdict');
    }
  } else {
    unchecked.push({ link: 'verdict', detail: 'No verdict was supplied, so it was not verified.' });
  }

  return { ok: broken.length === 0, broken, unchecked, checked };
}
