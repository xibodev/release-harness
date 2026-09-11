/**
 * Execution bindings and the eligibility gate.
 *
 * A contract says what must hold of a subject. Bindings say where to go and
 * find out. They are structurally separate types living in separate files
 * because the alternative -- one bucket with a `normative: true` flag -- makes
 * identity semantics depend on a mutable boolean, and a boolean someone can
 * flip is not a boundary.
 *
 * The current code gets this exactly wrong: it builds one policy snapshot
 * containing topology and origins (bindings) alongside scenarios (assertions),
 * writes it as one file, and hashes it as one unit. One digest covers both, so
 * changing a port changes the proposition's identity. That is why the same
 * contract certified on a laptop and in CI produced two different identities
 * for one promise.
 *
 * The gate exists for a sharper reason. Eligibility must be decided BEFORE any
 * side effect -- before materialization, before starting a browser, before
 * sealing anything. Today the config that determines whether a run may certify
 * is read after Chromium has already launched and evidence has already been
 * written, which means the harness performs the work of certification and only
 * then asks whether it was entitled to. A gate that opens after the horse has
 * bolted is decoration.
 */

import crypto from 'node:crypto';
import { verifyAcceptedContract } from './acceptance.js';
import { MODE } from './attribution.js';

export const BINDING_SCHEMA_VERSION = '1.0.0';

/**
 * Resolve a contract's symbolic targets against a binding set.
 *
 * Assertions name what they exercise symbolically -- 'api', 'web'. This is what
 * turns those names into somewhere to go, and it is deliberately the only place
 * that happens: an assertion that carried its own URL would have baked a local
 * accident into a promise.
 *
 * Returns every unresolved target rather than throwing on the first, because an
 * operator fixing a binding file wants the whole list.
 */
export function resolveBindings(contract, bindings) {
  const unresolved = [];
  const resolved = {};

  const targets = new Set((contract?.assertions ?? []).map((a) => a.target).filter(Boolean));

  for (const target of [...targets].sort()) {
    const binding = bindings?.targets?.[target];
    if (binding === undefined || binding === null || binding === '') {
      unresolved.push(target);
      continue;
    }
    resolved[target] = binding;
  }

  return { resolved, unresolved, ok: unresolved.length === 0 };
}

/**
 * A stable digest of the binding set actually used for a run.
 *
 * This does NOT enter contract identity -- that is the whole point. It enters
 * RUN identity, so a verdict can say precisely where it looked without that
 * changing what was promised. Two runs of one contract against staging and
 * production are the same proposition, differently exercised, and both facts
 * need to be recoverable afterwards.
 */
export function bindingDigest(bindings) {
  const targets = bindings?.targets ?? {};
  const canonical = {};
  for (const key of Object.keys(targets).sort()) canonical[key] = targets[key];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

/**
 * Why a run may not certify. Each is a fact an operator can act on.
 */
export const INELIGIBLE = {
  NO_CONTRACT: 'NO_CONTRACT',
  CONTRACT_NOT_ACCEPTED: 'CONTRACT_NOT_ACCEPTED',
  CONTRACT_TAMPERED: 'CONTRACT_TAMPERED',
  BINDINGS_UNRESOLVED: 'BINDINGS_UNRESOLVED',
  NORMATIVE_REF_UNRESOLVED: 'NORMATIVE_REF_UNRESOLVED',
  NORMATIVE_REF_CHANGED: 'NORMATIVE_REF_CHANGED',
};

/**
 * Decide the run's mode before anything is executed.
 *
 * Call this FIRST, before materializing source, starting a process or browser,
 * or opening an evidence directory. The decision needs nothing that a side
 * effect produces, so there is no reason to defer it -- and deferring it is how
 * a run ends up having certified something it was never entitled to certify.
 *
 * Ineligibility is never an error. An unaccepted draft SHOULD be runnable: that
 * is how an author finds out whether their proposition survives contact with
 * the software before asking anyone to accept it. What that run may not do is
 * produce a certificate, and the reasons are returned so the operator knows
 * exactly which fact to change.
 *
 * @param {object|null} contract   The accepted contract, if there is one.
 * @param {object}      bindings   The binding set for this run.
 * @param {object}      [options]
 * @param {Record<string,string>} [options.resolvedRefs] Digests of the normative
 *   references as they are NOW, keyed by ref. A reference that has moved since
 *   acceptance means the contract is about something that no longer exists.
 */
export function decideMode(contract, bindings, options = {}) {
  const reasons = [];

  if (!contract) {
    reasons.push({
      code: INELIGIBLE.NO_CONTRACT,
      detail:
        'No accepted contract was supplied. A run can still proceed for feedback, ' +
        'but there is no accepted proposition for it to certify.',
    });
  } else if (typeof contract.digest !== 'string') {
    reasons.push({
      code: INELIGIBLE.CONTRACT_NOT_ACCEPTED,
      detail:
        'The contract carries no digest, so it was never accepted. A draft may be ' +
        'run for feedback; it cannot be certified.',
    });
  } else {
    const verified = verifyAcceptedContract(contract);
    if (!verified.ok) {
      reasons.push({ code: INELIGIBLE.CONTRACT_TAMPERED, detail: verified.reason });
    }

    // A normative reference that has moved means this contract was accepted
    // against something that no longer exists. Certifying it would attest to a
    // proposition whose meaning has quietly changed underneath -- precisely the
    // cross-repo failure this project exists to catch.
    const resolvedRefs = options.resolvedRefs ?? {};
    for (const req of contract.requires ?? []) {
      const current = resolvedRefs[req.ref];
      if (current === undefined) {
        reasons.push({
          code: INELIGIBLE.NORMATIVE_REF_UNRESOLVED,
          detail:
            `Normative reference "${req.ref}" could not be resolved, so it is ` +
            'unknown whether what this contract depends on still says the same thing.',
        });
      } else if (current !== req.digest) {
        reasons.push({
          code: INELIGIBLE.NORMATIVE_REF_CHANGED,
          detail:
            `Normative reference "${req.ref}" has changed since acceptance ` +
            `(accepted against ${req.digest.slice(0, 12)}…, now ${current.slice(0, 12)}…). ` +
            'The contract was accepted against a different proposition.',
        });
      }
    }
  }

  if (contract) {
    const { unresolved } = resolveBindings(contract, bindings);
    if (unresolved.length > 0) {
      reasons.push({
        code: INELIGIBLE.BINDINGS_UNRESOLVED,
        detail:
          `No binding for ${unresolved.map((t) => `"${t}"`).join(', ')}. ` +
          'An assertion whose target does not resolve cannot be exercised, and a ' +
          'run that skips it certifies less than it appears to.',
      });
    }
  }

  const eligible = reasons.length === 0;
  return {
    mode: eligible ? MODE.CERTIFYING : MODE.EXPLORATORY,
    eligible,
    reasons,
  };
}

/**
 * Independent facts about readiness -- never one aggregate flag.
 *
 * The decisive bug in the self-adoption fixture was a `doctor` command that
 * enumerated three absent contracts and then printed "Status: Ready." Every
 * individual fact it reported was true; the summary was false, and the summary
 * was the only part anyone read.
 *
 * So there is no summary. A caller that wants one must decide for itself what
 * it is claiming, which is the point: "ready" is not a property of an
 * installation, it is a claim about a specific intention.
 */
export function describeReadiness({ contract, bindings, resolvedRefs } = {}) {
  const decision = decideMode(contract ?? null, bindings ?? {}, { resolvedRefs });
  const codes = new Set(decision.reasons.map((r) => r.code));

  const contractAccepted = Boolean(contract && typeof contract.digest === 'string');

  return {
    contract_present: Boolean(contract),
    contract_accepted: contractAccepted,
    contract_intact: contractAccepted && !codes.has(INELIGIBLE.CONTRACT_TAMPERED),
    bindings_resolvable: Boolean(contract) && !codes.has(INELIGIBLE.BINDINGS_UNRESOLVED),
    normative_refs_current:
      !codes.has(INELIGIBLE.NORMATIVE_REF_CHANGED) &&
      !codes.has(INELIGIBLE.NORMATIVE_REF_UNRESOLVED),
    certification_eligible: decision.eligible,
    reasons: decision.reasons,
  };
}
