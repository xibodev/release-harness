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
import { contractSemanticFindings } from './contract.js';

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

  return contractSemanticFindings(candidate);
}

/**
 * One blocker per semantic violation.
 *
 * Two layers legitimately discover the same fact -- acceptability sees an
 * assertion with no `kind` as unfinished, the contract standard sees it as
 * undeclared -- and a reader should be told once. Deduplication keys on the
 * violation's identity (code + path + entity), never on its wording, so
 * improving a message cannot silently reintroduce the duplicate.
 *
 * Distinct violations on the same field survive: a missing kind and an
 * unsupported kind are different conditions with different remedies, and
 * collapsing them by path would hide one of them.
 */
function dedupe(blockers) {
  const seen = new Set();
  const out = [];
  for (const b of blockers) {
    // A blocker with no code cannot be identified semantically, so it is kept
    // as-is rather than guessed at.
    const key = b.code ? `${b.code}|${b.path ?? ''}|${b.entity ?? ''}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(b);
  }
  return out;
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
  // `checkDraft` reports shape problems as prose. Where a problem is ALSO a
  // contract-semantics violation -- an unexecutable assertion kind is both --
  // the structured finding carries the identity, so the two are deduplicated
  // rather than reported twice under different wordings.
  const semanticByDetail = new Map(
    contractSemanticFindings({
      schema_version: '1.0.0',
      subject: draft?.proposition?.subject,
      assertions: (draft?.proposition?.assertions ?? []).map(({ supported_by, ...r }) => r),
      ...(draft?.proposition?.requires !== undefined ? { requires: draft.proposition.requires } : {}),
    }).map((f) => [f.detail, f])
  );

  const structural = [
    ...checkDraft(draft).map((detail) => {
      const f = semanticByDetail.get(detail);
      return f
        ? { kind: 'draft_invalid', code: f.code, path: f.path, entity: f.entity, detail }
        : { kind: 'draft_invalid', detail };
    }),
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
      blockers: dedupe([...structural, ...contractProblems(draft).filter((f) => f.code !== undefined).map((f) => ({
        kind: 'contract_invalid',
        code: f.code,
        path: f.path,
        entity: f.entity,
        detail: f.detail,
      }))]),
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
  //
  // Classified by CODE rather than by matching message text, which was the
  // previous approach and would have silently misclassified every finding the
  // moment a message was reworded.
  const INCOMPLETENESS = new Set([
    'SUBJECT_ID_MISSING',
    'SUBJECT_MISSING',
    'ASSERTIONS_EMPTY',
    'ASSERTION_ID_MISSING',
    'ASSERTION_KIND_MISSING',
    'ASSERTION_TARGET_MISSING',
  ]);

  const genuinelyInvalid = contractErrors.filter((f) => !INCOMPLETENESS.has(f.code));

  if (genuinelyInvalid.length > 0) {
    const asBlockers = genuinelyInvalid.map((f) => ({
      kind: 'contract_invalid',
      code: f.code,
      path: f.path,
      entity: f.entity,
      detail: f.detail,
    }));
    return {
      state: DRAFT_STATE.INVALID,
      acceptable: false,
      shape_valid: true,
      semantic_valid: false,
      errors: genuinelyInvalid.map((f) => f.detail),
      blockers: dedupe([...asBlockers, ...blockers]),
    };
  }

  // Anything the contract standard rejects that is merely emptiness surfaces as
  // work remaining, phrased as what to fill in.
  const emptiness = contractErrors
    .filter((f) => INCOMPLETENESS.has(f.code))
    .map((f) => ({ kind: 'incomplete', code: f.code, path: f.path, entity: f.entity, detail: f.detail }));

  // `blockers` first: acceptability's wording is written for an author
  // ("has no kind yet"), the contract standard's for a validator.
  const all = dedupe([...blockers, ...emptiness]);

  return {
    state: all.length === 0 ? DRAFT_STATE.ACCEPTABLE : DRAFT_STATE.BLOCKED,
    acceptable: all.length === 0,
    shape_valid: true,
    semantic_valid: true,
    errors: [],
    blockers: all,
  };
}
