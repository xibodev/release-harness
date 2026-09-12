/**
 * `accept` -- take responsibility for a proposition.
 *
 * Acceptance means someone deliberately says "this is the right question." It
 * does not mean the proposition is true, exhaustive, or that shipping is a good
 * idea; the run decides that, and conflating the two is how a certificate comes
 * to mean "we hope so."
 *
 * Repeat acceptance is deterministic, which matters more than it first appears.
 * The same resolved proposition accepted twice by two people on two days is ONE
 * proposition with two acceptance events. So the contract file is written once
 * and never rewritten, while acceptance events accumulate beside it. If time or
 * operator identity produced a second artifact, the digest would stop being an
 * identity and start being a receipt.
 *
 * A changed proposition gets a new digest and a new file, and the old one stays
 * exactly where it was. Nothing is overwritten: the record of what was
 * previously promised is the thing evolution will later be measured against.
 */

import fs from 'node:fs';
import { paths, readJson, writeJson, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import { acceptDraft, AcceptanceRefused } from '../acceptance.js';
import { assessDraft, DRAFT_STATE } from '../assess.js';
import { renderBlockers, describeState } from './blockers.js';

export function cmdAccept(ctx) {
  const { cwd, out, args } = ctx;

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const name = typeof args.flags.draft === 'string' ? args.flags.draft : args.positional[1];
  if (!name) {
    out.error('Usage: release-harness accept --draft <name> --by "<who>"');
    return EXIT.USAGE_OR_CONTRACT;
  }

  // Acceptance must be attributed. An unattributed acceptance records that
  // someone took responsibility without recording who, which is the same as
  // recording nothing.
  const by = typeof args.flags.by === 'string' ? args.flags.by : null;
  if (!by) {
    out.error('Acceptance must say who is accepting. Pass --by "<your name>".');
    out.error('This is attribution, not authorization: it records who took responsibility.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const draft = readJson(p.draft(name));
  const record = readJson(p.record(name));

  if (!draft.found) {
    out.error(`No draft named "${name}".`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (!record.found) {
    out.error(`Draft "${name}" has no authoring record, so there is no evidence to check.`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (draft.error || record.error) {
    out.error(draft.error ?? record.error);
    return EXIT.USAGE_OR_CONTRACT;
  }

  // The same assessment `validate` reported. Acceptance refuses on exactly the
  // facts validate showed, so the two can never disagree about whether a draft
  // was ready -- which is what D10 was.
  const assessment = assessDraft(draft.value, record.value);
  if (assessment.state !== DRAFT_STATE.ACCEPTABLE) {
    out.error(describeState(name, assessment));
    renderBlockers({ detail: (m) => out.error(`  ${m}`), blank: () => {} }, assessment.blockers, {
      fullTextAt: p.draft(name),
    });
    out.data('assessment', { state: assessment.state, blockers: assessment.blockers });
    return EXIT.USAGE_OR_CONTRACT;
  }

  let contract;
  try {
    contract = acceptDraft(draft.value, record.value, {
      by,
      at: typeof args.flags.at === 'string' ? args.flags.at : undefined,
      note: typeof args.flags.note === 'string' ? args.flags.note : undefined,
    });
  } catch (err) {
    if (err instanceof AcceptanceRefused) {
      out.error(`Cannot accept draft "${name}":`);
      for (const b of err.blockers) out.error(`  [${b.kind}] ${b.detail}`);
      out.data('blockers', err.blockers);
      return EXIT.USAGE_OR_CONTRACT;
    }
    out.error(err.message);
    return EXIT.USAGE_OR_CONTRACT;
  }

  const { digest, accepted, ...proposition } = contract;
  const contractFile = p.contract(digest);
  const acceptanceFile = p.acceptance(digest);
  const alreadyAccepted = fs.existsSync(contractFile);

  // The proposition is written once. Re-accepting an identical proposition
  // must not rewrite it: the file is content-addressed, so rewriting it could
  // only ever produce the same bytes, and leaving it alone makes that explicit.
  if (!alreadyAccepted) {
    writeJson(contractFile, { ...proposition, digest });
  }

  // Acceptance events accumulate. Each points AT the digest rather than living
  // inside it, which is what keeps "who agreed" out of "what was agreed".
  const existing = readJson(acceptanceFile);
  const events = existing.found && Array.isArray(existing.value?.events) ? existing.value.events : [];
  events.push(accepted);
  writeJson(acceptanceFile, {
    schema_version: '1.0.0',
    contract_digest: digest,
    events,
  });

  out.data('digest', digest);
  out.data('contract_file', contractFile);
  out.data('repeat', alreadyAccepted);

  if (alreadyAccepted) {
    out.ok(`Already accepted: ${digest.slice(0, 16)}…`);
    out.blank();
    out.info('This is the same proposition, so it keeps the same identity.');
    out.info(`Recorded a further acceptance by ${by} (${events.length} total).`);
  } else {
    out.ok(`Accepted ${digest.slice(0, 16)}…`);
    out.detail(contractFile);
    out.blank();
    out.info('The file is named by its own digest and must not be edited.');
    out.info('To change what is promised, edit the draft and accept again --');
    out.info('that produces a new contract, and leaves this one intact.');
  }

  out.blank();
  out.info('Next:');
  out.info('  release-harness bind <name> --target <symbol>=<location>');

  return EXIT.OK;
}
