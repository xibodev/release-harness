/**
 * Drafts, authoring records, and what it takes to claim something.
 *
 * A draft is the mutable proposal. An authoring record is the separate account
 * of how its claims were arrived at. They coexist deliberately: the draft says
 * what is proposed, the record says what was actually looked at, and keeping
 * them apart is what stops "an agent believed this" from being stored as if it
 * were "this was observed."
 *
 * The hard part is absence. Five absence errors were produced by three careful
 * actors during the research behind this design -- the highest-recurrence defect
 * found anywhere in it. Every one had the same shape: a search was run, nothing
 * came back, and "nothing came back" was recorded as "it does not exist."
 *
 * Those are different statements. Finding a file proves it exists. Failing to
 * find one proves nothing at all unless you know where you looked and whether
 * you finished looking. So evidence for a negative claim must carry its bounds,
 * and a search that was killed, truncated, or errored cannot produce a claim of
 * absence at any confidence -- it produces `not_established`, which supports
 * nothing.
 *
 * This is enforced by construction rather than by convention: `classifySearch`
 * is the only supported way to turn a search outcome into a status, and it
 * cannot return `observed_absent` for a search that did not complete.
 */

import { EXECUTABLE_KINDS } from './contract.js';

export const DRAFT_SCHEMA_VERSION = '1.0.0';

/**
 * Epistemic status: what is known about a claim, and what that permits.
 *
 * `supports` answers one question -- may an accepted assertion rest on this?
 * It is the gate acceptance consults, so the distinctions are load-bearing
 * rather than descriptive.
 */
export const EPISTEMIC_STATUS = {
  /** Directly read. The strongest positive claim. */
  observed: { supports: true, draftOnly: false },

  /**
   * A bounded search completed and found nothing. Supports a claim ONLY because
   * the bounds are recorded: without method, roots and completion, "not found"
   * is a statement about the search, not about the world.
   */
  observed_absent: { supports: true, draftOnly: false },

  /**
   * A test or contract asserts the thing must not exist. The assertion IS the
   * evidence, and it is stronger than any search: it states intent rather than
   * current state.
   *
   * This is the status nobody anticipates. During the research a workflow file
   * looked like the perfect example of "declarations go stale" -- until a test
   * was found asserting that the file must not exist. Two independent actors
   * got it backwards by using `ls` as a proxy for intent. A file that is absent
   * because someone decided it should be is not the same fact as a file that
   * happens to be missing today.
   */
  asserted_absent: { supports: true, draftOnly: false },

  /**
   * An interpretation. Legitimate while drafting -- it is how a proposal gets
   * made -- but an accepted contract may not rest on one. Acceptance means
   * someone took responsibility for the claim, which requires converting the
   * inference into something checked, or asking the question outright.
   */
  inferred: { supports: false, draftOnly: true },

  /**
   * Nothing is established: the search never ran, failed, was killed, timed
   * out, or returned truncated results.
   *
   * This supports nothing, and that is the entire point. The failure mode this
   * prevents is silent and expensive -- an incomplete search reported as a
   * confident absence, which then justifies a decision nobody would have made
   * knowing the search never finished.
   */
  not_established: { supports: false, draftOnly: false },
};

export const EPISTEMIC_STATUSES = Object.keys(EPISTEMIC_STATUS);

/** May an accepted assertion rest on a claim in this status? */
export function supportsClaim(status) {
  return EPISTEMIC_STATUS[status]?.supports === true;
}

/** Is this status confined to drafts? */
export function isDraftOnly(status) {
  return EPISTEMIC_STATUS[status]?.draftOnly === true;
}

/** The statuses that assert something is absent, and so need bounded evidence. */
const ABSENCE_STATUSES = new Set(['observed_absent', 'asserted_absent']);

/**
 * Turn the outcome of a search into an epistemic status.
 *
 * This exists so the rule cannot be got wrong by someone who has not read it.
 * A caller cannot reach `observed_absent` through this function without having
 * completed the search, because the completion flag is checked before the
 * result is: an incomplete search is `not_established` whether or not it
 * happened to find something along the way.
 *
 * @param {object}   outcome
 * @param {boolean}  outcome.completed  Did the search run to completion? A
 *   killed, timed-out, errored, truncated or result-capped search did NOT
 *   complete, regardless of how much it covered.
 * @param {boolean}  outcome.found      Did it find the thing?
 * @param {string}   [outcome.method]   How the search was performed.
 * @param {string[]} [outcome.roots]    Where it looked.
 * @param {string[]} [outcome.exclusions] What it deliberately skipped.
 */
export function classifySearch(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    throw new TypeError('classifySearch requires a search outcome object');
  }
  if (typeof outcome.completed !== 'boolean') {
    // Not defaulted. A caller who has not thought about whether the search
    // finished is exactly the caller this function exists to stop, and a
    // default of `true` would reintroduce the defect silently.
    throw new TypeError(
      'classifySearch requires an explicit `completed` boolean; a search whose ' +
        'completion is unknown cannot establish absence'
    );
  }

  if (outcome.found === true) {
    // A positive finding stands on its own: it needs no bounds, because the
    // thing was seen. This also means an incomplete search that found the
    // thing still yields a usable positive claim.
    return 'observed';
  }

  if (!outcome.completed) return 'not_established';

  return 'observed_absent';
}

/**
 * Validate one claim in an authoring record.
 *
 * Returns every problem rather than the first, so an author fixes a record in
 * one pass. The asymmetry between positive and negative claims is the point:
 *
 *   - a positive claim needs one source reference; it was seen
 *   - a negative claim needs method, roots and explicit completion, because
 *     the claim is really about the search, and an unbounded search supports
 *     nothing
 */
export function checkClaim(claim, index) {
  const at = `claims[${index}]`;
  const errors = [];

  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    return [`${at} must be an object`];
  }

  // Emptiness is not malformedness. A scaffolded record with blank fields is a
  // record in its honest initial state, and reporting it as broken teaches an
  // author that validation output is noise to be worked around. What matters is
  // the TYPE being right; whether it has been filled in is a question for
  // acceptability, which says what to fill in rather than what is wrong.
  if (typeof claim.id !== 'string') {
    errors.push(`${at}.id must be a string`);
  }
  if (typeof claim.claim !== 'string') {
    errors.push(`${at}.claim must be a string`);
  }

  const status = claim.status;
  if (!EPISTEMIC_STATUSES.includes(status)) {
    errors.push(
      `${at}.status must be one of ${EPISTEMIC_STATUSES.join(', ')}; got ${JSON.stringify(status)}`
    );
    return errors; // the remaining checks are status-dependent
  }

  // `not_established` is the honest "we do not know" and needs no evidence --
  // demanding some would push authors toward claiming a stronger status.
  if (status === 'not_established') return errors;

  const ev = claim.evidence;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    errors.push(`${at}.evidence must be an object for status "${status}"`);
    return errors;
  }

  if (status === 'observed' || status === 'inferred') {
    if (typeof ev.source !== 'string' || !ev.source.trim()) {
      errors.push(`${at}.evidence.source must reference what was read`);
    }
    return errors;
  }

  if (status === 'asserted_absent') {
    // The assertion is the evidence, so it must be citable: a claim that
    // "something asserts this" without naming it is an inference wearing a
    // stronger status.
    if (typeof ev.asserted_by !== 'string' || !ev.asserted_by.trim()) {
      errors.push(
        `${at}.evidence.asserted_by must cite the test or contract that asserts ` +
          'nonexistence; without it this is an inference, not an assertion'
      );
    }
    return errors;
  }

  if (status === 'observed_absent') {
    if (typeof ev.method !== 'string' || !ev.method.trim()) {
      errors.push(`${at}.evidence.method must say how the search was performed`);
    }
    if (!Array.isArray(ev.roots) || ev.roots.length === 0) {
      errors.push(
        `${at}.evidence.roots must list where the search looked; "not found" is ` +
          'a statement about the search until its scope is known'
      );
    }
    if (ev.completed !== true) {
      errors.push(
        `${at}.evidence.completed must be true for "observed_absent"; a killed, ` +
          'timed-out or truncated search establishes nothing and must be recorded ' +
          'as "not_established"'
      );
    }
    // `exclusions` is optional but meaningful: a search that skipped node_modules
    // found nothing *there* too, and a reader deserves to know.
    if (ev.exclusions !== undefined && !Array.isArray(ev.exclusions)) {
      errors.push(`${at}.evidence.exclusions must be an array when present`);
    }
    return errors;
  }

  return errors;
}

/**
 * Validate an authoring record: the account of how a draft's claims were made.
 */
export function checkAuthoringRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['Authoring record must be an object'];
  }

  if (!Array.isArray(record.claims)) {
    errors.push('Authoring record must declare a "claims" array');
    return errors;
  }

  const seen = new Set();
  record.claims.forEach((claim, i) => {
    errors.push(...checkClaim(claim, i));
    if (claim && typeof claim.id === 'string' && claim.id.trim()) {
      if (seen.has(claim.id)) errors.push(`Duplicate claim id "${claim.id}"`);
      seen.add(claim.id);
    }
  });

  return errors;
}

/**
 * Validate a draft.
 *
 * A draft is permitted to be incomplete -- that is what distinguishes it from a
 * contract. It may hold inferences, open questions, and claims that establish
 * nothing. What it may not be is malformed, because an author needs the errors
 * that are real while the work is still in progress.
 */
export function checkDraft(draft) {
  const errors = [];

  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return ['Draft must be an object'];
  }

  const proposition = draft.proposition;
  if (!proposition || typeof proposition !== 'object') {
    errors.push('Draft must declare a "proposition"');
  } else {
    // An assertion with no kind yet is INCOMPLETE, which a draft is allowed to
    // be -- acceptability reports it as work remaining. An assertion with a
    // kind nothing can exercise is different in nature: no amount of filling in
    // makes it checkable, so it is wrong the moment it is written and is
    // reported here, where `validate` will show it.
    //
    // An adoption agent authored `kind: "process"`. It looked reasonable, it
    // validated, and it failed only when a run reached it -- after the operator
    // had taken responsibility for a proposition nothing could evaluate.
    for (const [i, a] of (proposition.assertions ?? []).entries()) {
      if (typeof a?.kind !== 'string' || !a.kind.trim()) continue;
      if (!EXECUTABLE_KINDS.includes(a.kind)) {
        errors.push(
          `assertions[${i}] has kind "${a.kind}", which this version cannot exercise ` +
            `(it knows: ${EXECUTABLE_KINDS.join(', ')}). An assertion that cannot be ` +
            'checked is a promise nobody can keep.'
        );
      }
    }
  }

  if (draft.questions !== undefined) {
    if (!Array.isArray(draft.questions)) {
      errors.push('"questions" must be an array when present');
    } else {
      draft.questions.forEach((q, i) => {
        if (!q || typeof q !== 'object') {
          errors.push(`questions[${i}] must be an object`);
          return;
        }
        if (typeof q.id !== 'string' || !q.id.trim()) {
          errors.push(`questions[${i}].id must be a non-empty string`);
        }
        if (typeof q.question !== 'string' || !q.question.trim()) {
          errors.push(`questions[${i}].question must be a non-empty string`);
        }
        if (q.blocking !== undefined && typeof q.blocking !== 'boolean') {
          errors.push(`questions[${i}].blocking must be a boolean when present`);
        }
        if (q.resolution !== undefined && typeof q.resolution !== 'string') {
          errors.push(`questions[${i}].resolution must be a string when present`);
        }
      });
    }
  }

  return errors;
}

/**
 * Correct the record when a later positive finding contradicts a recorded absence.
 *
 * A search that found nothing, followed by a finding, is not a contradiction to
 * be argued about -- the positive observation wins, because seeing the thing is
 * stronger evidence than having failed to see it. What must not happen is the
 * correction going unrecorded: the superseded claim is retained so a reader can
 * see that the earlier search was wrong, and how.
 *
 * Returns a new claim; does not mutate its input.
 */
export function correctWithObservation(claim, observation) {
  if (!claim || typeof claim !== 'object') {
    throw new TypeError('correctWithObservation requires a claim');
  }
  if (!observation || typeof observation.source !== 'string' || !observation.source.trim()) {
    throw new TypeError('A correcting observation must cite its source');
  }

  return {
    ...claim,
    status: 'observed',
    evidence: { source: observation.source },
    superseded: {
      status: claim.status,
      evidence: claim.evidence,
      reason:
        observation.reason ??
        'a direct observation found what an earlier search reported as absent',
    },
  };
}

/**
 * Can this draft be accepted, and if not, exactly why?
 *
 * Acceptance means someone takes responsibility for this being the question
 * asked. That is only meaningful if the claims underneath it hold up, so this
 * returns every blocker rather than a boolean -- an author deserves the whole
 * list, not the first obstacle.
 *
 * Note what is NOT a blocker: a claim in `not_established` that no assertion
 * depends on. Not knowing something irrelevant is fine, and demanding that
 * every recorded uncertainty be resolved would teach authors to delete
 * uncertainties rather than record them.
 */
export function checkAcceptability(draft, record) {
  const blockers = [];

  blockers.push(...checkDraft(draft).map((e) => ({ kind: 'draft_invalid', detail: e })));
  blockers.push(
    ...checkAuthoringRecord(record).map((e) => ({ kind: 'record_invalid', detail: e }))
  );
  if (blockers.length > 0) return { acceptable: false, blockers };

  // What the schema deliberately tolerates in a draft, acceptance must not.
  const subjectId = draft.proposition?.subject?.id;
  if (typeof subjectId !== 'string' || !subjectId.trim()) {
    blockers.push({
      kind: 'incomplete',
      detail: 'The subject has no id yet. Name what is being certified.',
    });
  }

  for (const [i, a] of (draft.proposition?.assertions ?? []).entries()) {
    for (const field of ['id', 'kind', 'target']) {
      if (typeof a?.[field] !== 'string' || !a[field].trim()) {
        blockers.push({
          kind: 'incomplete',
          detail: `assertions[${i}] has no ${field} yet.`,
        });
      }
    }
  }

  for (const [i, c] of (record.claims ?? []).entries()) {
    if (typeof c?.claim !== 'string' || !c.claim.trim()) {
      blockers.push({
        kind: 'incomplete',
        detail: `claims[${i}] states nothing yet. Say what is being claimed, or remove it.`,
      });
    }
  }

  for (const q of draft.questions ?? []) {
    const resolved = typeof q.resolution === 'string' && q.resolution.trim().length > 0;
    if (q.blocking === true && !resolved) {
      blockers.push({
        kind: 'unresolved_question',
        detail: `Blocking question "${q.id}" is unresolved: ${q.question}`,
      });
    }
  }

  const claimsById = new Map((record.claims ?? []).map((c) => [c.id, c]));
  const assertions = draft.proposition?.assertions ?? [];

  for (const assertion of assertions) {
    for (const claimId of assertion.supported_by ?? []) {
      const claim = claimsById.get(claimId);

      if (!claim) {
        blockers.push({
          kind: 'missing_claim',
          detail: `Assertion "${assertion.id}" cites claim "${claimId}", which the authoring record does not contain`,
        });
        continue;
      }

      if (!supportsClaim(claim.status)) {
        blockers.push({
          kind: 'unsupported_claim',
          detail:
            `Assertion "${assertion.id}" rests on claim "${claimId}", which is ` +
            `"${claim.status}"` +
            (isDraftOnly(claim.status)
              ? ' -- an interpretation may propose an assertion but cannot support an accepted one'
              : ' -- nothing was established, so this assertion has no evidence behind it'),
        });
      }
    }
  }

  return { acceptable: blockers.length === 0, blockers };
}
