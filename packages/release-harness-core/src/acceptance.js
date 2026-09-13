/**
 * Acceptance: turning a proposal into the question the harness will answer.
 *
 * Accepting a contract means someone deliberately takes responsibility for this
 * being the right question. It does NOT mean the proposition is true, that it
 * is exhaustive, or that deployment should proceed -- those are the run's job,
 * and conflating them is how a certificate starts meaning "we hope so."
 *
 * Acceptance emits; it does not mutate. The draft stays as it was, and an
 * immutable, content-addressed contract is produced from it. This is deliberate:
 * `accepted: true` written into a mutable file is a flag, not a boundary --
 * anyone can set it, anyone can edit the file afterwards, and nothing detects
 * that the accepted thing and the current thing have diverged. A separate
 * artifact whose name IS its digest cannot drift without becoming a different
 * artifact.
 *
 * Editing an accepted contract is therefore not possible by design. You reopen
 * a draft and accept a new proposition, which gets a new identity -- because it
 * is a new promise.
 */

import { canonicalizeContract, contractDigest, checkContractSemantics } from './contract.js';
import { checkAcceptability } from './draft.js';

export const ACCEPTED_CONTRACT_SCHEMA_VERSION = '1.0.0';

/**
 * Raised when acceptance is refused. Carries every blocker, so an author sees
 * the whole list rather than fixing one problem at a time.
 */
export class AcceptanceRefused extends Error {
  constructor(blockers) {
    const lines = blockers.map((b) => `  - [${b.kind}] ${b.detail}`).join('\n');
    super(`Cannot accept this draft:\n${lines}`);
    this.name = 'AcceptanceRefused';
    this.blockers = blockers;
  }
}

/**
 * Accept a draft, emitting an immutable contract.
 *
 * The emitted artifact carries its own digest as a convenience for readers --
 * but that digest is computed over the identity fields only, never over the
 * artifact as a whole, so it stays independently reproducible by anyone holding
 * the contract. A digest that covered its own envelope could not be recomputed
 * without knowing how the envelope was built, which would make it unverifiable
 * in exactly the situation verification matters.
 *
 * @param {object} draft            The proposal.
 * @param {object} record           The authoring record behind its claims.
 * @param {object} acceptance
 * @param {string} acceptance.by    Who accepted. Attribution, not authorization
 *                                  -- vNext has no PKI, and pretending otherwise
 *                                  would overstate what this guarantees.
 * @param {string} [acceptance.at]  ISO timestamp; defaults to now.
 * @param {string} [acceptance.note] Why, in the accepter's words.
 */
export function acceptDraft(draft, record, acceptance) {
  if (!acceptance || typeof acceptance.by !== 'string' || !acceptance.by.trim()) {
    throw new TypeError(
      'Acceptance must name who accepted. An unattributed acceptance records ' +
        'that someone took responsibility without recording who, which is the ' +
        'same as recording nothing'
    );
  }

  const { acceptable, blockers } = checkAcceptability(draft, record);
  if (!acceptable) throw new AcceptanceRefused(blockers);

  // The proposition becomes a contract. Draft-only scaffolding -- the claim
  // references each assertion was built from -- is dropped here: it belongs to
  // the authoring record, which is retained separately. Keeping it would put
  // authoring history inside proposition identity.
  const proposition = {
    schema_version: ACCEPTED_CONTRACT_SCHEMA_VERSION,
    subject: draft.proposition.subject,
    assertions: draft.proposition.assertions.map(({ supported_by, ...rest }) => rest),
  };
  if (draft.proposition.requires !== undefined) {
    proposition.requires = draft.proposition.requires;
  }

  // A draft may be incomplete; a contract may not. This is the last point at
  // which that can be caught, and catching it here rather than at run time is
  // the difference between a refused acceptance and a broken certificate.
  const semanticErrors = checkContractSemantics(proposition);
  if (semanticErrors.length > 0) {
    throw new AcceptanceRefused(
      semanticErrors.map((detail) => ({ kind: 'contract_invalid', detail }))
    );
  }

  const canonical = canonicalizeContract(proposition);
  const digest = contractDigest(canonical);

  return {
    ...canonical,
    // Everything below is envelope, deliberately outside identity: the same
    // proposition accepted by two people on two days is one proposition.
    digest,
    accepted: {
      by: acceptance.by,
      at: acceptance.at ?? new Date().toISOString(),
      ...(acceptance.note ? { note: acceptance.note } : {}),
    },
  };
}

/**
 * Verify that an accepted contract still says what its digest claims.
 *
 * This is the check that makes the artifact worth anything. If someone edits an
 * accepted contract in place -- adds an assertion, relaxes an expectation -- the
 * recomputed digest no longer matches the stored one, and every downstream
 * artifact that cited the old digest is now visibly citing something else.
 */
export function verifyAcceptedContract(contract) {
  if (!contract || typeof contract !== 'object') {
    return { ok: false, reason: 'Accepted contract must be an object' };
  }
  if (typeof contract.digest !== 'string' || !/^[0-9a-f]{64}$/.test(contract.digest)) {
    return { ok: false, reason: 'Accepted contract must carry a sha256 digest' };
  }

  let recomputed;
  try {
    recomputed = contractDigest(contract);
  } catch (err) {
    return { ok: false, reason: `Contract could not be canonicalized: ${err.message}` };
  }

  if (recomputed !== contract.digest) {
    return {
      ok: false,
      reason:
        'The contract does not match its digest: it was edited after acceptance. ' +
        'An accepted contract is immutable -- reopen a draft and accept a new one.',
      claimed: contract.digest,
      actual: recomputed,
    };
  }

  return { ok: true, digest: recomputed };
}
