/**
 * `doctor` -- report facts, and never a verdict on readiness.
 *
 * This command is where the self-adoption fixture's decisive bug lived. The old
 * implementation enumerated three absent contracts and then printed
 * "Status: Ready", exit 0. Every individual fact it reported was true. The
 * summary was false, and the summary was the only line anyone read.
 *
 * So there is no summary line. Each fact is reported on its own terms, and the
 * closest thing to a conclusion is the single question an operator actually
 * has -- can this certify right now? -- answered from the same gate `run` uses,
 * so the two can never disagree.
 *
 * The distinction the old output destroyed is between "valid" and "true". A
 * document can satisfy every structural rule and still describe software that
 * does not exist. `doctor` says which of those it has checked, in the same
 * breath, because conflating them is what let a fabrication read as readiness.
 */

import fs from 'node:fs';
import { paths, readJson, listDrafts, listAccepted, listBindings, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import { validateDraft, validateAuthoringRecord, validateAcceptedContract } from '../validator.js';
import { checkAcceptability } from '../draft.js';
import { describeReadiness } from '../bindings.js';

function safe(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.errors?.[0] ?? err.message;
  }
}

export function cmdDoctor(ctx) {
  const { cwd, out, version } = ctx;
  const facts = [];
  const say = (label, value, note) => facts.push({ label, value, note });

  // --- installation --------------------------------------------------------
  const installed = isInstalled(cwd);
  say('installation', installed ? 'present' : 'absent', installed ? undefined : 'run `release-harness init`');

  if (!installed) {
    out.data('facts', facts);
    out.heading('release-harness');
    out.info(`installation   absent`);
    out.detail('Run `release-harness init` to install.');
    out.blank();
    out.info('No contract exists. Nothing can be certified.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);

  // --- drafts --------------------------------------------------------------
  const draftNames = listDrafts(cwd);
  say('drafts', draftNames.length === 0 ? 'none' : `${draftNames.length}`);

  const draftFacts = [];
  for (const name of draftNames) {
    const draft = readJson(p.draft(name));
    const record = readJson(p.record(name));

    const structural =
      draft.error ??
      safe(() => validateDraft(draft.value)) ??
      (record.found ? record.error ?? safe(() => validateAuthoringRecord(record.value)) : 'no authoring record');

    if (structural) {
      draftFacts.push({ name, wellFormed: false, detail: structural });
      continue;
    }

    const { acceptable, blockers } = checkAcceptability(draft.value, record.value);
    draftFacts.push({
      name,
      wellFormed: true,
      acceptable,
      blockers: blockers.map((b) => `[${b.kind}] ${b.detail}`),
    });
  }

  // --- accepted contracts --------------------------------------------------
  const digests = listAccepted(cwd);
  say('accepted contracts', digests.length === 0 ? 'none' : `${digests.length}`);

  const contractFacts = [];
  for (const digest of digests) {
    const loaded = readJson(p.contract(digest));
    const problem = loaded.error ?? safe(() => validateAcceptedContract(loaded.value));
    const acceptance = readJson(p.acceptance(digest));
    contractFacts.push({
      digest,
      intact: !problem,
      detail: problem,
      subject: loaded.value?.subject?.id,
      assertions: loaded.value?.assertions?.length ?? 0,
      acceptances: acceptance.value?.events?.length ?? 0,
    });
  }

  // --- bindings ------------------------------------------------------------
  const bindingNames = listBindings(cwd);
  say('bindings', bindingNames.length === 0 ? 'none' : bindingNames.join(', '));

  // --- eligibility ---------------------------------------------------------
  // Computed by the same gate `run` uses. If doctor said "ready" and run
  // disagreed, doctor would be lying in the old way again.
  const eligibility = [];
  for (const c of contractFacts.filter((c) => c.intact)) {
    const contract = readJson(p.contract(c.digest)).value;
    for (const b of bindingNames) {
      const binding = readJson(p.binding(b)).value;
      const readiness = describeReadiness({ contract, bindings: binding });
      eligibility.push({
        digest: c.digest,
        binding: b,
        eligible: readiness.certification_eligible,
        reasons: readiness.reasons.map((r) => `[${r.code}] ${r.detail}`),
      });
    }
  }

  out.data('facts', facts);
  out.data('drafts', draftFacts);
  out.data('contracts', contractFacts);
  out.data('eligibility', eligibility);
  out.data('certification_eligible', eligibility.some((e) => e.eligible));

  // --- render --------------------------------------------------------------
  out.heading(`release-harness ${version}`);

  out.info(`installation        present`);
  out.info(`drafts              ${draftNames.length === 0 ? 'none' : draftNames.length}`);
  for (const d of draftFacts) {
    if (!d.wellFormed) {
      out.detail(`${d.name}: malformed -- ${d.detail}`);
    } else if (d.acceptable) {
      out.detail(`${d.name}: well-formed, ready to accept`);
    } else {
      out.detail(`${d.name}: well-formed, ${d.blockers.length} unresolved`);
      for (const b of d.blockers) out.detail(`  ${b}`);
    }
  }

  out.info(`accepted contracts  ${digests.length === 0 ? 'none' : digests.length}`);
  for (const c of contractFacts) {
    if (!c.intact) {
      out.detail(`${c.digest.slice(0, 12)}…: BROKEN -- ${c.detail}`);
    } else {
      out.detail(
        `${c.digest.slice(0, 12)}…: ${c.subject}, ${c.assertions} assertion${c.assertions === 1 ? '' : 's'}, ` +
          `${c.acceptances} acceptance${c.acceptances === 1 ? '' : 's'}`
      );
    }
  }

  out.info(`bindings            ${bindingNames.length === 0 ? 'none' : bindingNames.join(', ')}`);

  out.blank();

  // The one conclusion offered, phrased as the question an operator has.
  if (eligibility.length === 0) {
    out.info('Can anything be certified right now?  No.');
    if (digests.length === 0 && draftNames.length === 0) {
      out.detail('Nothing has been drafted yet.');
      out.detail('release-harness does not inspect your project or guess what it does.');
    } else if (digests.length === 0) {
      out.detail('No draft has been accepted. A draft is a proposal, not a promise.');
    } else if (bindingNames.length === 0) {
      out.detail('No binding exists, so there is nowhere to check the contract against.');
    }
    out.blank();

    // Structural validity is stated separately from truth, always.
    if (draftFacts.some((d) => d.wellFormed)) {
      out.info('Note: "well-formed" means the files parse and satisfy their schema.');
      out.info('It does not mean the assertions are true of your software.');
    }
    return EXIT.UNPROVEN;
  }

  out.info('Can anything be certified right now?');
  for (const e of eligibility) {
    if (e.eligible) {
      out.detail(`yes -- ${e.digest.slice(0, 12)}… against binding "${e.binding}"`);
    } else {
      out.detail(`no  -- ${e.digest.slice(0, 12)}… against binding "${e.binding}"`);
      for (const r of e.reasons) out.detail(`     ${r}`);
    }
  }

  return eligibility.some((e) => e.eligible) ? EXIT.OK : EXIT.UNPROVEN;
}
