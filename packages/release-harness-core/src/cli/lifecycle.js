/** Deterministic lifecycle status and noninteractive freshness gate. */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { captureGitSource, deriveLifecycleReadiness } from '../lifecycle.js';
import { validateChangeReview, validateReviewConfirmation } from '../validator.js';
import {
  paths,
  readJson,
  isInstalled,
  listDrafts,
  listAccepted,
  listBindings,
  listConfirmedReviews,
  resolveAccepted,
} from './layout.js';
import { EXIT } from './exit-codes.js';

function config(cwd) {
  return readJson(paths(cwd).config).value ?? {};
}

function selectedContract(cwd, ref) {
  const p = paths(cwd);
  const resolved = resolveAccepted(cwd, ref);
  if (!resolved.ok) return { error: resolved.reason };
  const loaded = readJson(p.contract(resolved.digest));
  return loaded.error ? { error: loaded.error } : { digest: resolved.digest, contract: loaded.value };
}

function confirmedFor(cwd, contractDigest) {
  const p = paths(cwd);
  const candidates = [];
  for (const digest of listConfirmedReviews(cwd)) {
    const review = readJson(p.confirmedReview(digest));
    const confirmation = readJson(p.reviewConfirmation(digest));
    if (review.error || confirmation.error || !review.found || !confirmation.found) continue;
    try {
      validateChangeReview(review.value);
      validateReviewConfirmation(confirmation.value);
    } catch {
      continue;
    }
    if (review.value.contract?.digest === contractDigest) {
      candidates.push({ review: review.value, confirmation: confirmation.value });
    }
  }
  return candidates.sort((a, b) => String(b.confirmation.events?.at(-1)?.at ?? '').localeCompare(String(a.confirmation.events?.at(-1)?.at ?? '')))[0];
}

function gitStatus(cwd) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return { applicable: false, warnings: [] };
  const warnings = [];
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const durable = [
    { pattern: /^\.release-harness\/drafts\/.*\.draft\.json$/, label: 'draft' },
    { pattern: /^\.release-harness\/drafts\/.*\.record\.json$/, label: 'authoring record' },
    { pattern: /^\.release-harness\/accepted\//, label: 'accepted contract state' },
    { pattern: /^\.release-harness\/reviews\//, label: 'lifecycle review' },
  ];
  const ignoredRoot = lines.some((line) => line === '!! .release-harness/' || line === '!! .release-harness\\');
  for (const { pattern, label } of durable) {
    let count = lines.filter((line) => (line.startsWith('?? ') || line.startsWith('!! ')) && pattern.test(line.slice(3).replace(/\\/g, '/'))).length;
    if (ignoredRoot && count === 0) {
      const dir = label === 'draft' || label === 'authoring record'
        ? paths(cwd).drafts
        : label === 'accepted contract state'
          ? paths(cwd).accepted
          : paths(cwd).reviews;
      if (fs.existsSync(dir)) {
        const suffix = label === 'draft' ? '.draft.json' : label === 'authoring record' ? '.record.json' : '.json';
        count = fs.readdirSync(dir, { recursive: true }).filter((file) => String(file).endsWith(suffix)).length;
      }
    }
    if (count) {
      const ignored = ignoredRoot || lines.some((line) => line.startsWith('!! ') && pattern.test(line.slice(3).replace(/\\/g, '/')));
      warnings.push({ code: ignored ? 'DURABLE_STATE_IGNORED' : 'DURABLE_STATE_UNTRACKED', detail: `${count} ${ignored ? 'ignored ' : ''}${label}${count === 1 ? '' : 's'} exist only in this checkout. Another checkout or future session will not see them.` });
    }
  }
  const trackedRuns = lines.filter((line) => !line.startsWith('?? ') && line.slice(3).replace(/\\/g, '/').startsWith('.release-harness/runs/'));
  if (trackedRuns.length) warnings.push({ code: 'LOCAL_STATE_TRACKED', detail: `${trackedRuns.length} run artifact(s) are tracked even though runs are local by default.` });
  const trackedBindings = lines.filter((line) => !line.startsWith('?? ') && line.slice(3).replace(/\\/g, '/').startsWith('.release-harness/bindings/'));
  if (trackedBindings.length) warnings.push({ code: 'LOCAL_BINDING_TRACKED', detail: `${trackedBindings.length} binding artifact(s) are tracked; confirm they are portable and nonsecret.` });
  return { applicable: true, warnings };
}

export function lifecycleFacts(cwd, ref) {
  const accepted = listAccepted(cwd);
  const drafts = listDrafts(cwd);
  const bindings = listBindings(cwd);
  const tracking = gitStatus(cwd);
  const selected = accepted.length ? selectedContract(cwd, ref) : null;
  let coverage = { eligible: false, reasons: [{ code: 'CONTRACT_MISSING', detail: 'No accepted contract is selected.' }] };
  let currentSources = [];
  let confirmed;

  if (selected && !selected.error) {
    confirmed = confirmedFor(cwd, selected.digest);
    const sourceIds = confirmed?.review?.sources?.map((s) => s.source_id) ?? ['primary'];
    currentSources = sourceIds.map((sourceId) => captureGitSource(cwd, { sourceId }));
    coverage = deriveLifecycleReadiness({
      contract: selected.contract,
      currentSources,
      review: confirmed?.review,
      confirmation: confirmed?.confirmation,
    });
  }

  return {
    enabled: config(cwd).lifecycle?.enabled === true,
    current_sources: currentSources,
    accepted_contracts: accepted,
    drafts,
    bindings,
    confirmed_review: confirmed?.review?.digest ?? null,
    review_conclusion: confirmed?.review?.conclusion?.action ?? null,
    source_coverage: coverage,
    tracking,
  };
}

function render(out, facts) {
  out.data('lifecycle', facts);
  out.heading('Release-Harness lifecycle');
  out.info(`continuous lifecycle  ${facts.enabled ? 'enabled' : 'not enabled'}`);
  out.info(`accepted contracts    ${facts.accepted_contracts.length || 'none'}`);
  out.info(`active drafts         ${facts.drafts.length || 'none'}`);
  out.info(`confirmed review      ${facts.confirmed_review ? facts.confirmed_review.slice(0, 12) + '…' : 'none'}`);
  out.info(`review conclusion    ${facts.review_conclusion ?? 'none'}`);
  for (const source of facts.current_sources) {
    out.info(`source ${source.source_id.padEnd(12)} ${source.status === 'established' ? source.reviewed_source_digest.slice(0, 12) + '…' : 'not established'}`);
  }
  out.info(`review covers source  ${facts.source_coverage.eligible ? 'yes' : 'no'}`);
  for (const reason of facts.source_coverage.reasons) out.detail(`[${reason.code}] ${reason.detail}`);
  for (const warning of facts.tracking.warnings) out.detail(`Warning: ${warning.detail}`);
}

export function cmdLifecycle(ctx) {
  const { cwd, out, args } = ctx;
  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const sub = args.positional[1] ?? 'status';
  if (!['status', 'check'].includes(sub)) {
    out.error(`Unknown lifecycle subcommand "${sub}". Expected: status, check.`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  const facts = lifecycleFacts(cwd, typeof args.flags.contract === 'string' ? args.flags.contract : undefined);
  render(out, facts);
  if (sub === 'check' && !facts.enabled) {
    out.info('Lifecycle policy is not enabled; plain contract execution remains available.');
    return EXIT.OK;
  }
  if (!facts.enabled) return EXIT.OK;
  if (!facts.source_coverage.eligible || facts.tracking.warnings.length) return EXIT.UNPROVEN;
  return EXIT.OK;
}
