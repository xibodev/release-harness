/**
 * Continuous lifecycle around an immutable accepted proposition.
 *
 * Nothing here enters contract identity. A review answers a later, different
 * question: has someone deliberately reviewed this exact source set and taken
 * responsibility for reusing the accepted proposition against it?
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkClaim } from './draft.js';

const SEMANTIC_FACT_PATTERN = /(?:\b(?:proposition|contract|promise|assertion)\b[\s\S]*\b(?:unchanged|same meaning|still means|still appropriate)\b)|(?:\b(?:unchanged|same meaning|still means|still appropriate)\b[\s\S]*\b(?:proposition|contract|promise|assertion)\b)/i;
const PROGRESSION = new Set(['reuse_contract', 'rebind']);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  }
  return out;
}

export function artifactDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export function canonicalizeReview(review) {
  const { proposed, digest, confirmed, ...identity } = review ?? {};
  // Git context such as commit/tree explains where the review happened, but
  // exact source coverage is the release-source projection digest. Excluding
  // contextual head labels keeps committing the review itself from changing
  // the identity of an otherwise identical baseline/change review.
  const sources = (identity.sources ?? []).map(({ head_commit, head_tree, ...source }) => source);
  return canonical({ ...identity, sources });
}

export function reviewDigest(review) {
  return artifactDigest(canonicalizeReview(review));
}

function runGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, value: r.stdout.trim() } : { ok: false, reason: (r.stderr || r.stdout).trim() };
}

function repositoryIdentity(cwd) {
  const remote = runGit(cwd, ['config', '--get', 'remote.origin.url']);
  return remote.ok && remote.value ? remote.value : path.resolve(cwd);
}

/**
 * Exact Git-backed source projection.
 *
 * Every tracked file participates except .release-harness/**. No semantic path
 * filters are applied. This intentionally makes a README change require a
 * quick review: conservative and explainable before clever and wrong.
 */
export function captureGitSource(cwd, {
  sourceId,
  repositoryIdentity: identity,
  baseRef,
} = {}) {
  const source_id = sourceId || 'primary';
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.value !== 'true') {
    return { source_id, status: 'not_established', reason: 'Path is not a Git repository.' };
  }

  const dirty = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!dirty.ok) {
    return { source_id, status: 'not_established', reason: 'Git working-tree state could not be established.' };
  }
  const productChanges = dirty.value
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(3).replace(/\\/g, '/');
      return file !== '.release-harness' && !file.startsWith('.release-harness/');
    });
  if (productChanges.length > 0) {
    return {
      source_id,
      status: 'not_established',
      repository_identity: identity ?? repositoryIdentity(cwd),
      ...(baseRef ? { base_ref: baseRef } : {}),
      reason: `Uncommitted product source exists (${productChanges.length} path${productChanges.length === 1 ? '' : 's'}); exact source identity cannot be established.`,
    };
  }

  let base_commit;
  let merge_base;
  if (baseRef) {
    const base = runGit(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (!base.ok) {
      return {
        source_id,
        status: 'not_established',
        repository_identity: identity ?? repositoryIdentity(cwd),
        base_ref: baseRef,
        reason: `Comparison base ref "${baseRef}" could not be established.`,
      };
    }
    base_commit = base.value;
    const merged = runGit(cwd, ['merge-base', base_commit, 'HEAD']);
    if (!merged.ok) {
      return {
        source_id,
        status: 'not_established',
        repository_identity: identity ?? repositoryIdentity(cwd),
        base_ref: baseRef,
        reason: `Merge base for "${baseRef}" could not be established.`,
      };
    }
    merge_base = merged.value;
  }

  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  const tree = runGit(cwd, ['rev-parse', 'HEAD^{tree}']);
  const listed = runGit(cwd, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  if (!head.ok || !tree.ok || !listed.ok) {
    return { source_id, status: 'not_established', reason: 'Current Git source identity could not be established.' };
  }

  const rows = listed.value
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (!match) return null;
      const [, mode, type, object, file] = match;
      if (file === '.release-harness' || file.startsWith('.release-harness/')) return null;
      return { mode, type, object, path: file };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));

  const changed_paths = [];
  if (merge_base) {
    const diff = runGit(cwd, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', merge_base, 'HEAD']);
    if (!diff.ok) {
      return { source_id, status: 'not_established', reason: 'Changed paths could not be enumerated.' };
    }
    const fields = diff.value.split('\0').filter(Boolean);
    for (let i = 0; i < fields.length; i += 2) {
      const meta = fields[i];
      const file = fields[i + 1];
      const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
      if (!m || !file || file.startsWith('.release-harness/')) continue;
      const status = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type_changed' }[m[5]] ?? 'modified';
      changed_paths.push({ status, path: file, old_blob: m[3], new_blob: m[4] });
    }
    changed_paths.sort((a, b) => a.path.localeCompare(b.path));
  }

  return {
    source_id,
    status: 'established',
    repository_identity: identity ?? repositoryIdentity(cwd),
    ...(baseRef ? { base_ref: baseRef, base_commit, merge_base } : {}),
    head_commit: head.value,
    head_tree: tree.value,
    reviewed_source_digest: artifactDigest(rows),
    changed_paths,
  };
}

function duplicates(values) {
  const seen = new Set();
  return values.filter((x) => (seen.has(x) ? true : (seen.add(x), false)));
}


export function reviewScaffold({ contract, sources, mode = 'change', authoringProvenance, proposedBy = '' }) {
  return {
    schema_version: '1.0.0',
    mode,
    contract: { digest: contract.digest },
    authoring_provenance: authoringProvenance ?? { status: 'not_available' },
    sources,
    facts: [],
    impact: {
      assertions: (contract.assertions ?? []).map((a) => ({ id: a.id, impact: 'not_established', supported_by: [] })),
      requires: (contract.requires ?? []).map((r) => ({ ref: r.ref, digest: r.digest, impact: 'not_established', supported_by: [] })),
      possible_binding_changes: [],
    },
    questions: [],
    conclusion: { action: 'block', summary: 'Semantic impact has not been established.' },
    proposed: { by: proposedBy || 'unattributed', at: new Date().toISOString() },
  };
}

export function validateReviewSemantics(review, contract) {
  const errors = [];
  if (!review || typeof review !== 'object') return ['Review must be an object'];
  if (!contract || review.contract?.digest !== contract.digest) {
    errors.push('Review must identify the selected accepted contract digest.');
  }

  const factIds = (review.facts ?? []).map((f) => f.id);
  for (const id of duplicates(factIds)) errors.push(`Duplicate fact id "${id}".`);
  for (const [index, fact] of (review.facts ?? []).entries()) {
    for (const error of checkClaim(fact, index)) errors.push(`Review fact ${error}`);
    if (fact.status === 'observed' && SEMANTIC_FACT_PATTERN.test(fact.claim ?? '')) {
      errors.push(`Fact "${fact.id}" states a semantic judgment; record that under impact or conclusion.`);
    }
    if (fact.status === 'observed_absent') {
      const e = fact.evidence ?? {};
      if (e.completed !== true || !e.method || !Array.isArray(e.roots)) {
        errors.push(`Fact "${fact.id}" cannot establish absence without completed bounded evidence.`);
      }
    }
  }

  const assertionIds = (contract?.assertions ?? []).map((a) => a.id);
  const mappedAssertions = (review.impact?.assertions ?? []).map((a) => a.id);
  for (const id of assertionIds) {
    if (!mappedAssertions.includes(id)) errors.push(`Assertion "${id}" must be accounted for in review impact.`);
  }
  for (const id of mappedAssertions) {
    if (!assertionIds.includes(id)) errors.push(`Review impact names unknown assertion "${id}".`);
  }
  for (const id of duplicates(mappedAssertions)) errors.push(`Assertion "${id}" is mapped more than once.`);

  const required = (contract?.requires ?? []).map((r) => `${r.ref}|${r.digest}`);
  const mappedRequires = (review.impact?.requires ?? []).map((r) => `${r.ref}|${r.digest}`);
  for (const key of required) {
    if (!mappedRequires.includes(key)) errors.push(`Normative reference "${key.split('|')[0]}" must be accounted for in review impact.`);
  }
  for (const key of mappedRequires) {
    if (!required.includes(key)) errors.push(`Review impact names a normative identity not present in the contract: "${key}".`);
  }

  for (const item of [...(review.impact?.assertions ?? []), ...(review.impact?.requires ?? [])]) {
    for (const fact of item.supported_by ?? []) {
      if (!factIds.includes(fact)) errors.push(`Impact entry cites missing fact "${fact}".`);
    }
  }

  const questions = review.questions ?? [];
  for (const q of questions) {
    if ((q.resolution && !q.resolved_by) || (q.resolved_by && !q.resolution)) {
      errors.push(`Question "${q.id}" resolution must name who resolved it.`);
    }
  }

  if (PROGRESSION.has(review.conclusion?.action)) {
    const open = questions.filter((q) => q.blocking && (!q.resolution || !q.resolved_by));
    if (open.length) errors.push(`Authoritative progression has ${open.length} unresolved blocking question(s).`);
  }

  return errors;
}

export function confirmReview(review, contract, { by, at, note } = {}) {
  if (typeof by !== 'string' || !by.trim()) {
    throw new TypeError('Review confirmation must name who confirms.');
  }
  const errors = validateReviewSemantics(review, contract);
  if (errors.length) throw new Error(`Review cannot be confirmed:\n${errors.join('\n')}`);
  if (!PROGRESSION.has(review.conclusion?.action)) {
    throw new Error(`Review action "${review.conclusion?.action}" already blocks certification and needs no confirmation to be safe.`);
  }

  const digest = reviewDigest(review);
  return {
    // Keep proposal attribution in the stored review for explainability, but it
    // remains outside semantic identity because reviewDigest/canonicalizeReview
    // explicitly exclude it.
    review: { ...review, digest },
    confirmation: {
      review_digest: digest,
      events: [{ by: by.trim(), at: at ?? new Date().toISOString(), ...(note ? { note } : {}) }],
    },
  };
}

export function deriveLifecycleReadiness({ contract, currentSources = [], review, confirmation } = {}) {
  const reasons = [];
  const action = review?.conclusion?.action;

  if (!review) {
    reasons.push({ code: 'REVIEW_MISSING', detail: 'No lifecycle review covers the selected accepted contract.' });
  } else if (review.contract?.digest !== contract?.digest) {
    reasons.push({ code: 'REVIEW_CONTRACT_MISMATCH', detail: 'The review covers a different accepted contract.' });
  }

  if (review) {
    const sourceById = new Map(currentSources.map((s) => [s.source_id, s]));
    for (const covered of review.sources ?? []) {
      const current = sourceById.get(covered.source_id);
      if (covered.status !== 'established' || !current || current.status !== 'established') {
        reasons.push({ code: 'SOURCE_NOT_ESTABLISHED', detail: `Source "${covered.source_id}" cannot be compared.` });
      } else if (current.reviewed_source_digest !== covered.reviewed_source_digest) {
        reasons.push({ code: 'REVIEW_STALE', detail: `Review source "${covered.source_id}" does not cover current source.` });
      }
    }
    for (const current of currentSources) {
      if (!(review.sources ?? []).some((s) => s.source_id === current.source_id)) {
        reasons.push({ code: 'SOURCE_UNREVIEWED', detail: `Current source "${current.source_id}" is not covered by the review.` });
      }
    }

    if (action === 'block' || action === 'reauthor') {
      reasons.push({ code: 'REVIEW_BLOCKS_RELEASE', detail: `Review conclusion is "${action}".` });
    } else if (PROGRESSION.has(action)) {
      const digest = review.digest ?? reviewDigest(review);
      if (!confirmation || confirmation.review_digest !== digest || !(confirmation.events ?? []).some((e) => e.by)) {
        reasons.push({ code: 'REVIEW_UNCONFIRMED', detail: 'Reuse requires attributable confirmation of this exact review.' });
      }
    }
  }

  return { eligible: reasons.length === 0, reasons };
}
