/**
 * `verify` -- check a run's chain of custody from the files alone.
 *
 * This command is the reason the hashes are worth writing. The research found
 * `verdict_sha256` and `config_hashes` written by the old harness and never read
 * back by anything, which is worse than not writing them: a hash nobody checks
 * looks like a guarantee while being decoration, and it invites exactly the
 * trust it has not earned.
 *
 * A link that cannot be checked is reported as unchecked, never as passed.
 * "I could not verify this" and "this is fine" are the two statements this
 * project exists to keep apart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import { verifyRunManifest } from '../run-manifest.js';
import { EvidenceSealer } from '../sealer.js';

function latestRun(cwd) {
  const dir = paths(cwd).runs;
  if (!fs.existsSync(dir)) return null;
  const runs = fs
    .readdirSync(dir)
    .filter((f) => fs.existsSync(path.join(dir, f, 'manifest.json')))
    .sort();
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

export function cmdVerify(ctx) {
  const { cwd, out, args } = ctx;

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const runId = args.positional[1] ?? latestRun(cwd);

  if (!runId) {
    out.error('No runs to verify.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const runDir = p.run(runId);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));

  if (!manifest.found) {
    out.error(`No run named "${runId}".`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (manifest.error) {
    // A manifest that will not parse is itself a break in the chain: the record
    // of what happened has been damaged.
    out.error(manifest.error);
    return EXIT.HARNESS_OR_INTEGRITY;
  }

  // Load whatever the manifest cites. What cannot be loaded stays unchecked
  // rather than being assumed intact.
  const held = {};
  if (verdict.found && !verdict.error) held.verdict = verdict.value;

  if (manifest.value.contract?.digest) {
    const contract = readJson(p.contract(manifest.value.contract.digest));
    if (contract.found && !contract.error) held.contract = contract.value;
  }

  const evidenceDir = path.join(runDir, 'evidence');
  if (fs.existsSync(evidenceDir)) {
    held.sealer = new EvidenceSealer(evidenceDir, runId);
  }

  const chain = verifyRunManifest(manifest.value, held);

  out.data('run_id', runId);
  out.data('ok', chain.ok);
  out.data('checked', chain.checked);
  out.data('broken', chain.broken);
  out.data('unchecked', chain.unchecked);

  out.heading(`Verifying ${runId}`);

  for (const link of chain.checked) out.info(`ok         ${link}`);
  for (const u of chain.unchecked) {
    out.info(`unchecked  ${u.link}`);
    out.detail(u.detail);
  }
  for (const b of chain.broken) {
    out.info(`BROKEN     ${b.link}`);
    out.detail(b.detail);
  }

  out.blank();

  if (!chain.ok) {
    out.info(`${chain.broken.length} link${chain.broken.length === 1 ? '' : 's'} broken.`);
    out.info('This run is not trustworthy: what it claims and what it holds disagree.');
    return EXIT.HARNESS_OR_INTEGRITY;
  }

  if (chain.unchecked.length > 0) {
    out.info(`${chain.checked.length} verified, ${chain.unchecked.length} could not be checked.`);
    out.info('Nothing is broken, but the chain is not complete.');
    return EXIT.UNPROVEN;
  }

  const m = manifest.value;
  out.info(`The whole chain verifies (${chain.checked.join(', ')}).`);
  out.blank();
  out.info(`  contract   ${m.contract ? m.contract.digest.slice(0, 16) + '…' : '(none -- exploratory)'}`);
  out.info(`  bindings   ${m.bindings.digest.slice(0, 16)}…`);
  out.info(`  evidence   ${m.evidence.manifest_sha256.slice(0, 16)}…`);
  out.info(`  verdict    ${m.verdict.digest.slice(0, 16)}… (${m.verdict.status})`);
  out.info(`  certifying ${m.certification.eligible ? 'yes' : 'no'}`);

  return EXIT.OK;
}
