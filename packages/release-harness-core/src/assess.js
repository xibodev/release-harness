/**
 * One assessment of a draft, consumed by every command that has an opinion
 * about it.
 *
 * D10 was `validate` reporting "ready to accept" for a draft that `accept` then
 * refused. Two commands, one state, opposite answers -- and the one that said
 * yes is the one the protocol tells authors to rely on. The cause was two
 * implementations of the same question: `checkAcceptability` asked whether the
 * evidence held up, and `checkContractSemantics` asked whether the proposition
 * would even BE a contract, and only acceptance called the second one.
 *
 * So there is now a single function that answers the whole question, and
 * `validate`, `accept` and `doctor` all consume it. They may render it
 * differently; they may not decide it differently. A disagreement between them
 * is no longer a bug to find, it is a thing that cannot be expressed.
 *
 * The three states it distinguishes are deliberate, and the vocabulary is
 * load-bearing because Fixture A originally collapsed them:
 *
 *   INVALID   something written is wrong -- a kind nothing can execute, an
 *             unknown field, a malformed reference. The author made a mistake.
 *   BLOCKED   the draft is legitimate authoring material with semantic
 *             decisions outstanding. Nobody made a mistake; the work is not
 *             finished. Automation must not proceed, and the text must not
 *             call this invalid.
 *   ACCEPTABLE valid, and every blocker relevant to the proposition resolved.
 */

import { checkDraft, checkAuthoringRecord, checkAcceptability } from './draft.js';
import { checkContractSemantics } from './contract.js';

export const DRAFT_STATE = {
  INVALID: 'INVALID',
  BLOCKED: 'BLOCKED',
  ACCEPTABLE: 'ACCEPTABLE',
};

/**
 * Would this proposition be a contract if accepted?
 *
 * Acceptance emits a contract, so the draft's proposition is held to the
 * contract's standard here rather than at the moment of acceptance. Catching it
 * earlier is the whole point: an author learns their proposition is
 * unacceptable while it is still cheap to change, not when they try to commit
 * to it.
 */
function contractProblems(draft) {
  const proposition = draft?.proposition;
  if (!proposition || typeof proposition !== 'object') return [];

  // The shape acceptance would emit: authoring scaffolding dropped, because
  // `supported_by` belongs to the record and never reaches a contract.
  const candidate = {
    schema_version: '1.0.0',
    subject: proposition.subject,
    assertions: (proposition.assertions ?? []).map(({ supported_by, ...rest }) => rest),
    ...(proposition.requires !== undefined ? { requires: proposition.requires } : {}),
  };

  return checkContractSemantics(candidate);
}

/**
 * Assess a draft and its authoring record.
 *
 * Returns structured facts, never prose. Rendering belongs to whoever is
 * displaying it; the facts are the same for everyone.
 *
 * @param {object} draft
 * @param {object} record
 * @returns {{
 *   state: string,
 *   acceptable: boolean,
 *   shape_valid: boolean,
 *   semantic_valid: boolean,
 *   errors: string[],
 *   blockers: Array<{kind: string, detail: string}>,
 * }}
 */
export function assessDraft(draft, record) {
  // 1. Is it well-formed? A draft may be incomplete -- that is what makes it a
  //    draft -- but it may not be malformed.
  const structural = [
    ...checkDraft(draft).map((detail) => ({ kind: 'draft_invalid', detail })),
    ...checkAuthoringRecord(record ?? { claims: [] }).map((detail) => ({
      kind: 'record_invalid',
      detail,
    })),
  ];

  if (structural.length > 0) {
    return {
      state: DRAFT_STATE.INVALID,
      acceptable: false,
      shape_valid: false,
      semantic_valid: false,
      errors: structural.map((b) => b.detail),
      blockers: structural,
    };
  }

  // 2. Would the proposition be a contract? An assertion nothing can execute,
  //    or a normative reference nothing pins, is wrong rather than unfinished.
  const contractErrors = contractProblems(draft);

  // 3. Does the evidence hold up, and has every semantic decision been made?
  const { blockers } = checkAcceptability(draft, record ?? { claims: [] });

  // An incomplete draft is BLOCKED, not INVALID: the fields are empty because
  // the work is unfinished, and calling that "invalid" teaches an author that
  // validation output is noise to be worked around.
  const incomplete = blockers.filter((b) => b.kind === 'incomplete');
  // Emptiness is unfinished, not wrong. A scaffolded assertion with no kind or
  // target yet, a subject with no id, a claim that states nothing -- all are a
  // draft in its honest initial state, and reporting them as INVALID teaches an
  // author that validation output is noise to work around.
  //
  // What IS invalid: something written down that cannot be right however much
  // more is written. A kind nothing can execute. A reference nothing pins.
  const EMPTINESS = /must declare a non-empty "assertions"|subject\.id must be|must declare a "kind"|must declare a symbolic "target"|\.id must be a non-empty/;
  const genuinelyInvalid = contractErrors.filter((e) => !EMPTINESS.test(e));

  if (genuinelyInvalid.length > 0) {
    const asBlockers = genuinelyInvalid.map((detail) => ({ kind: 'contract_invalid', detail }));
    return {
      state: DRAFT_STATE.INVALID,
      acceptable: false,
      shape_valid: true,
      semantic_valid: false,
      errors: genuinelyInvalid,
      blockers: [...asBlockers, ...blockers],
    };
  }

  // Anything the contract standard rejects that is merely emptiness surfaces as
  // work remaining, phrased as what to fill in.
  const emptiness = contractErrors
    .filter((e) => !genuinelyInvalid.includes(e))
    .filter((e) => !incomplete.some((b) => b.detail.includes('subject') && /subject/.test(e)))
    .map((detail) => ({ kind: 'incomplete', detail }));

  const all = [...blockers, ...emptiness];

  return {
    state: all.length === 0 ? DRAFT_STATE.ACCEPTABLE : DRAFT_STATE.BLOCKED,
    acceptable: all.length === 0,
    shape_valid: true,
    semantic_valid: true,
    errors: [],
    blockers: all,
  };
}
