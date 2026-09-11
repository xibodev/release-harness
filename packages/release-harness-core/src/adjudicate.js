/**
 * Adjudication: sealed observations in, verdict out.
 *
 * This is the deterministic core of the product. Given the same observations,
 * the same contract and the same mode, it returns the same verdict -- always,
 * with no reference to how the run was invoked, what the CLI printed, or
 * anything a caller decided along the way.
 *
 * It exists as its own module because the alternative was worse than it looked.
 * The first version of the vNext CLI computed verdicts inline: whether an
 * observation supported a product attribution, how failures aggregated into a
 * status, which exit code followed. Every one of those is a rule a future API
 * caller or authoring agent would need to apply identically, and a rule that
 * lives in a command handler is a rule that gets reimplemented slightly
 * differently by the second caller.
 *
 * The old architecture had such a module and it was deleted along with the
 * scenario model it served. What is restored here is not that code -- it is the
 * property that made it worth having: one place where a run's meaning is
 * decided, reachable by anyone, dependent on nothing but its inputs.
 */

import { attributeFailure, MODE, CAUSE } from './attribution.js';

export const VERDICT_SCHEMA_VERSION = '1.0.0';

/**
 * Does this observation support attributing the failure to the subject?
 *
 * Product attribution needs an observation OF THE SUBJECT'S BEHAVIOUR, not
 * merely a failed run. An adapter that established the subject was never
 * reached has produced evidence about the binding; an adapter that could not
 * establish either way has produced no evidence about responsibility at all.
 *
 * The adapter records this structurally in `subject_reached`, which is exactly
 * why that field exists: so this decision reads a fact rather than inferring
 * one from output.
 */
function supportsProductAttribution(observation) {
  if (observation.cause !== CAUSE.PRODUCT) return false;
  // `true` is the only value that establishes it. `false` means demonstrably
  // not reached; 'not_established' means unknown. Neither supports an accusation.
  return observation.detail?.subject_reached === true;
}

/**
 * Adjudicate one observation against the accepted assertions.
 */
function adjudicateOne(observation, { acceptedIds, mode }) {
  if (observation.passed) {
    return { id: observation.id, status: 'PASS', observed: observation.observed };
  }

  const verdict = attributeFailure(
    {
      reported: observation.cause,
      // A product bug is the violation of a promise. Without an accepted
      // assertion there is no promise, so there is nothing to have violated.
      hasAcceptedAssertion: acceptedIds.has(observation.id),
      hasSupportingEvidence: supportsProductAttribution(observation),
    },
    mode
  );

  return {
    id: observation.id,
    status: 'FAIL',
    cause: verdict.cause,
    authoritative: verdict.authoritative,
    rationale: verdict.rationale,
    observed: observation.observed,
  };
}

/**
 * The certification status of a run.
 *
 * An exploratory run never reaches PASS. Everything it attempted may have
 * succeeded -- which is worth knowing and is reported -- but a PASS is a claim
 * that an accepted proposition holds, and an exploratory run has no accepted
 * proposition to make that claim about.
 */
function certificationStatus({ certifying, failures }) {
  if (failures.length > 0) return 'FAIL';
  return certifying ? 'PASS' : 'UNPROVEN';
}

/**
 * Whether the run's own machinery held up.
 *
 * Distinct from whether the subject passed: a run whose evidence did not seal,
 * or whose harness threw, cannot support a conclusion about the subject in
 * either direction.
 */
function runIntegrity({ adjudicated, evidenceSealed }) {
  if (!evidenceSealed) return 'EVIDENCE_INVALID';
  if (adjudicated.some((a) => a.cause === CAUSE.EVIDENCE_INVALID)) return 'EVIDENCE_INVALID';
  if (adjudicated.some((a) => a.cause === CAUSE.HARNESS_INTERNAL || a.cause === CAUSE.HARNESS_ENVIRONMENT)) {
    return 'HARNESS_ERROR';
  }
  return 'COMPLETE';
}

/**
 * The distinct causes present, in a stable order.
 *
 * Sorted rather than insertion-ordered so that two runs with the same problems
 * produce byte-identical verdicts regardless of which assertion happened to
 * fail first.
 */
function aggregateCauses(adjudicated) {
  return [...new Set(adjudicated.filter((a) => a.status === 'FAIL').map((a) => a.cause))].sort();
}

/**
 * Adjudicate a run.
 *
 * @param {object}   args
 * @param {string}   args.runId
 * @param {object[]} args.observations   What the adapters observed. Sealed.
 * @param {object|null} args.contract    The accepted contract, if any.
 * @param {string}   args.mode           CERTIFYING or EXPLORATORY.
 * @param {boolean}  [args.evidenceSealed=true]
 *
 * @returns {object} The verdict. Deterministic in its inputs.
 */
export function adjudicate({ runId, observations, contract = null, mode, evidenceSealed = true }) {
  if (!runId) throw new TypeError('Adjudication requires a run id');
  if (!mode) throw new TypeError('Adjudication requires an explicit mode');
  if (!Array.isArray(observations)) throw new TypeError('Adjudication requires observations');

  const acceptedIds = new Set((contract?.assertions ?? []).map((a) => a.id));
  const certifying = mode === MODE.CERTIFYING;

  const adjudicated = observations.map((o) => adjudicateOne(o, { acceptedIds, mode }));
  const failures = adjudicated.filter((a) => a.status === 'FAIL');

  return {
    schema_version: VERDICT_SCHEMA_VERSION,
    run_id: runId,
    status: certificationStatus({ certifying, failures }),
    certifying,
    run_integrity: runIntegrity({ adjudicated, evidenceSealed }),
    contract_digest: contract?.digest ?? null,
    causes: aggregateCauses(adjudicated),
    assertions: adjudicated,
    summary: {
      total: adjudicated.length,
      passed: adjudicated.length - failures.length,
      failed: failures.length,
    },
  };
}

/**
 * The exit code a verdict implies.
 *
 * Here rather than in the CLI because it is a statement about what the verdict
 * MEANS, and any caller reporting a run needs the same mapping. The CLI's job
 * is to return it, not to decide it.
 */
export function exitCodeForVerdict(verdict) {
  // A broken run cannot support a conclusion about the subject either way, so
  // its own failure is reported ahead of anything it seemed to observe.
  if (verdict.run_integrity === 'EVIDENCE_INVALID') return 4;
  if (verdict.run_integrity === 'HARNESS_ERROR') return 4;

  if (!verdict.certifying) return 2;
  if (verdict.status === 'PASS') return 0;

  // A substantiated product finding is the only thing that exits 1. Everything
  // unattributed lands on 2, so CI can never read silence as an accusation.
  if (verdict.causes.includes(CAUSE.PRODUCT)) return 1;
  if (verdict.causes.includes(CAUSE.CONTRACT_INVALID) || verdict.causes.includes(CAUSE.BINDING_INVALID)) {
    return 3;
  }
  return 2;
}
