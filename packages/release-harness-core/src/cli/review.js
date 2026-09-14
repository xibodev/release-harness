/** `review` -- collect exact source facts, then author and confirm semantic impact. */

import fs from 'node:fs';
import path from 'node:path';
import {
  artifactDigest,
  captureGitSource,
  confirmReview,
  reviewScaffold,
  validateReviewSemantics,
} from '../lifecycle.js';
import { validateChangeReview } from '../validator.js';
import { paths, readJson, writeJson, isInstalled, resolveAccepted, listReviews } from './layout.js';
import { EXIT } from './exit-codes.js';

function loadContract(cwd, ref) {
  const p = paths(cwd);
  const resolved = resolveAccepted(cwd, ref);
  if (!resolved.ok) return { error: resolved.reason };
  const loaded = readJson(p.contract(resolved.digest));
  if (loaded.error) return { error: loaded.error };
  return { contract: loaded.value, digest: resolved.digest };
}

function sourceSpecs(args, cwd) {
  const raw = args.flags.source;
  if (!raw) return [{ id: 'primary', directory: cwd, repositoryIdentity: undefined }];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => {
    const [id, directory, identity] = String(value).split('=');
    return { id, directory: path.resolve(cwd, directory || '.'), repositoryIdentity: identity };
  });
}

function cmdStart(ctx) {
  const { cwd, out, args } = ctx;
  const name = args.positional[2];
  if (!name) {
    out.error('Usage: release-harness review start <name> [--contract <digest>] [--base <ref>] [--source <id>=<path>]');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const loaded = loadContract(cwd, typeof args.flags.contract === 'string' ? args.flags.contract : undefined);
  if (loaded.error) {
    out.error(loaded.error);
    return EXIT.USAGE_OR_CONTRACT;
  }

  const base = typeof args.flags.base === 'string' ? args.flags.base : undefined;
  const specs = sourceSpecs(args, cwd);
  const sources = specs.map((spec) => captureGitSource(spec.directory, {
    sourceId: spec.id,
    repositoryIdentity: spec.repositoryIdentity,
    baseRef: base,
  }));
  const mode = base ? 'change' : 'baseline';
  const p = paths(cwd);
  const file = p.review(name);
  if (fs.existsSync(file) && !args.flags.force) {
    out.error(`A review named "${name}" already exists. Pass --force to replace the mutable scaffold.`);
    return EXIT.USAGE_OR_CONTRACT;
  }

  const recordNames = fs.existsSync(p.drafts)
    ? fs.readdirSync(p.drafts).filter((f) => f.endsWith('.record.json'))
    : [];
  let authoringProvenance = { status: 'not_available', reason: 'No retained authoring record was selected.' };
  if (recordNames.length === 1) {
    const recordPath = path.join(p.drafts, recordNames[0]);
    const bytes = fs.readFileSync(recordPath);
    authoringProvenance = {
      status: 'established',
      path: path.relative(cwd, recordPath).split(path.sep).join('/'),
      digest: artifactDigest(JSON.parse(bytes)),
    };
  }

  const review = reviewScaffold({
    contract: loaded.contract,
    sources,
    mode,
    authoringProvenance,
    proposedBy: typeof args.flags.by === 'string' ? args.flags.by : 'unattributed',
  });
  writeJson(file, review);

  out.ok(`Created ${mode} review "${name}"`);
  out.detail(file);
  for (const source of sources) {
    out.detail(`${source.source_id}: ${source.status}${source.status === 'established' ? ` ${source.reviewed_source_digest.slice(0, 12)}…` : ` -- ${source.reason}`}`);
  }
  out.blank();
  out.info('The CLI collected source facts only. An agent or person must author semantic impact.');
  out.info(`Then: release-harness review validate ${name}`);
  return sources.every((s) => s.status === 'established') ? EXIT.OK : EXIT.UNPROVEN;
}

function cmdValidate(ctx) {
  const { cwd, out, args } = ctx;
  const name = args.positional[2];
  if (!name) {
    out.error('Usage: release-harness review validate <name>');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const p = paths(cwd);
  const loaded = readJson(p.review(name));
  if (!loaded.found || loaded.error) {
    out.error(loaded.error ?? `No review named "${name}".`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  const contract = loadContract(cwd, loaded.value.contract?.digest);
  if (contract.error) {
    out.error(contract.error);
    return EXIT.USAGE_OR_CONTRACT;
  }
  try {
    validateChangeReview(loaded.value);
  } catch (error) {
    out.error(error.errors?.join('\n') ?? error.message);
    return EXIT.USAGE_OR_CONTRACT;
  }
  const errors = validateReviewSemantics(loaded.value, contract.contract);
  if (errors.length) {
    for (const error of errors) out.error(error);
    out.data('errors', errors);
    return EXIT.UNPROVEN;
  }
  out.ok(`Review "${name}" is well-formed and semantically complete.`);
  return EXIT.OK;
}

function cmdConfirm(ctx) {
  const { cwd, out, args } = ctx;
  const name = args.positional[2];
  const by = typeof args.flags.by === 'string' ? args.flags.by : '';
  if (!name || !by) {
    out.error('Usage: release-harness review confirm <name> --by "<actor>"');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const p = paths(cwd);
  const loaded = readJson(p.review(name));
  if (!loaded.found || loaded.error) {
    out.error(loaded.error ?? `No review named "${name}".`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  const contract = loadContract(cwd, loaded.value.contract?.digest);
  if (contract.error) {
    out.error(contract.error);
    return EXIT.USAGE_OR_CONTRACT;
  }
  let confirmed;
  try {
    validateChangeReview(loaded.value);
    confirmed = confirmReview(loaded.value, contract.contract, {
      by,
      at: typeof args.flags.at === 'string' ? args.flags.at : undefined,
      note: typeof args.flags.note === 'string' ? args.flags.note : undefined,
    });
  } catch (error) {
    out.error(error.errors?.join('\n') ?? error.message);
    return EXIT.USAGE_OR_CONTRACT;
  }
  fs.mkdirSync(p.confirmedReviews, { recursive: true });
  const reviewFile = p.confirmedReview(confirmed.review.digest);
  const confirmationFile = p.reviewConfirmation(confirmed.review.digest);
  if (!fs.existsSync(reviewFile)) writeJson(reviewFile, confirmed.review);
  const existing = readJson(confirmationFile);
  const events = existing.value?.events ?? [];
  writeJson(confirmationFile, {
    schema_version: '1.0.0',
    review_digest: confirmed.review.digest,
    events: [...events, ...confirmed.confirmation.events],
  });
  out.ok(`Confirmed ${confirmed.review.digest.slice(0, 16)}… by ${by}`);
  out.detail(reviewFile);
  return EXIT.OK;
}

function cmdList(ctx) {
  const { cwd, out } = ctx;
  const reviews = listReviews(cwd);
  if (!reviews.length) out.info('No mutable lifecycle reviews.');
  else for (const name of reviews) out.info(name);
  out.data('reviews', reviews);
  return EXIT.OK;
}

export function cmdReview(ctx) {
  const { cwd, out, args } = ctx;
  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const sub = args.positional[1];
  if (sub === 'start') return cmdStart(ctx);
  if (sub === 'validate') return cmdValidate(ctx);
  if (sub === 'confirm') return cmdConfirm(ctx);
  if (sub === 'list' || !sub) return cmdList(ctx);
  out.error(`Unknown review subcommand "${sub}". Expected: start, validate, confirm, list.`);
  return EXIT.USAGE_OR_CONTRACT;
}
