/**
 * `draft` -- create and inspect proposals.
 *
 * `draft new` writes a skeleton with the fields a person must fill in and no
 * values invented by the tool. The skeleton's questions are the interesting
 * part: they are pre-filled with the things a contract author always has to
 * decide, so the default state of a new draft is "unresolved", not "ready".
 */

import fs from 'node:fs';
import { paths, writeJson, readJson, listDrafts, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import { describeStatuses } from '../draft.js';
import { describeAssertionKinds } from '../contract.js';
import { assessDraft, DRAFT_STATE } from '../assess.js';
import { renderBlockers, describeState } from './blockers.js';

/**
 * A skeleton draft.
 *
 * Note what is NOT here: no subject id derived from the directory name, no
 * assertion, no target, no port. The subject id is the one field a tool is most
 * tempted to guess -- the folder is right there -- and guessing it is how a
 * proposition acquires an identity nobody chose.
 */
function skeletonDraft() {
  return {
    schema_version: '1.0.0',
    proposition: {
      subject: {
        id: '',
        name: '',
      },
      assertions: [
        {
          id: 'A1',
          kind: '',
          target: '',
          description: '',
          expect: {},
          supported_by: [],
        },
      ],
    },
    questions: [
      {
        id: 'Q1',
        question: 'What must be true of this subject for a release to be acceptable?',
        blocking: true,
      },
    ],
  };
}

/**
 * A skeleton authoring record.
 *
 * The starting status is `not_established`, because that is the truth before
 * anyone has looked at anything -- and because it is the one status needing no
 * evidence, so a new record is valid the moment it is written.
 *
 * What each status requires is printed by `draft new`, not embedded in the
 * file. An adoption agent found the gap that guidance closes: the scaffold
 * suggests writing `observed`, and the schema then rejects it for a missing
 * `evidence.source` nothing had mentioned. But guidance does not belong inside
 * a machine artifact -- these files are closed to unknown properties, and that
 * closure is what makes the schema authoritative. Explaining the format inside
 * the format would open a second, uncontrolled metadata channel beside the
 * controlled one.
 */
function skeletonRecord() {
  return {
    schema_version: '1.0.0',
    authored_by: '',
    claims: [
      {
        id: 'C1',
        claim: '',
        status: 'not_established',
      },
    ],
  };
}

export function cmdDraft(ctx) {
  const { cwd, out, args } = ctx;
  const sub = args.positional[1];

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  if (sub === 'new') return draftNew(ctx);
  if (sub === 'list' || sub === undefined) return draftList(ctx);
  if (sub === 'status') return draftStatus(ctx);

  out.error(`Unknown draft subcommand "${sub}". Expected: new, list, status.`);
  return EXIT.USAGE_OR_CONTRACT;
}

function draftNew(ctx) {
  const { cwd, out, args } = ctx;
  const name = args.positional[2];

  if (!name) {
    out.error('Usage: release-harness draft new <name>');
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    out.error(`"${name}" is not a usable draft name. Use letters, digits, dot, dash or underscore.`);
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const draftFile = p.draft(name);
  const recordFile = p.record(name);

  if (fs.existsSync(draftFile) && !args.flags.force) {
    out.error(`A draft named "${name}" already exists. Pass --force to overwrite it.`);
    return EXIT.USAGE_OR_CONTRACT;
  }

  writeJson(draftFile, skeletonDraft());
  writeJson(recordFile, skeletonRecord());

  out.ok(`Created draft "${name}"`);
  out.detail(`${draftFile}`);
  out.detail(`${recordFile}`);
  out.blank();
  out.info('Both files are empty of claims about your software. Fill them in:');
  out.info('  - the draft says what must hold;');
  out.info('  - the record says how you know, and gets checked when you accept.');
  out.blank();
  // Derived from core, never restated here. A help text that keeps its own copy
  // of the evidence rules is a help text that will eventually contradict the
  // validator enforcing them.
  out.info('Each claim carries a status, and each status needs its own evidence:');
  for (const { status, requires } of describeStatuses()) {
    out.detail(`${status.padEnd(17)} needs ${requires}`);
  }
  out.blank();
  // Rendered from the same schema validation compiles, never a second list.
  // D19: an agent had to learn these by submitting invalid values, because
  // strict validation arrived without visible vocabulary.
  out.info('An assertion names a kind and what must hold of it:');
  for (const k of describeAssertionKinds()) {
    out.detail(`${k.kind}`);
    out.detail(`  expect: ${k.expect.map((e) => e.field).join(', ')}`);
  }
  out.detail('WHERE to reach the thing -- a URL, a command -- is an execution');
  out.detail('binding, not part of the assertion. See `release-harness bind`.');
  out.blank();
  out.info('A blocking question is resolved by editing it in the draft:');
  out.detail('{ "id": "Q1", "question": "...", "blocking": true,');
  out.detail('  "resolution": "the answer", "resolved_by": "your name" }');
  out.detail('Both fields are required -- a resolution nobody is named for cannot be');
  out.detail('told apart from an agent answering its own question.');
  out.blank();
  out.info(`Then: release-harness validate --draft ${name}`);

  out.data('draft', name);
  out.data('files', { draft: draftFile, record: recordFile });
  return EXIT.OK;
}

function draftList(ctx) {
  const { cwd, out } = ctx;
  const names = listDrafts(cwd);

  out.data('drafts', names);

  if (names.length === 0) {
    out.info('No drafts. Create one with `release-harness draft new <name>`.');
    return EXIT.OK;
  }

  out.heading(`${names.length} draft${names.length === 1 ? '' : 's'}`);
  for (const name of names) out.info(name);
  return EXIT.OK;
}

function draftStatus(ctx) {
  const { cwd, out, args } = ctx;
  const name = args.positional[2] ?? args.flags.draft;

  if (!name || name === true) {
    out.error('Usage: release-harness draft status <name>');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const draft = readJson(p.draft(name));
  const record = readJson(p.record(name));

  if (!draft.found) {
    out.error(`No draft named "${name}".`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (draft.error || record.error) {
    out.error(draft.error ?? record.error);
    return EXIT.USAGE_OR_CONTRACT;
  }

  // The same assessment validate, accept and doctor consume. This command used
  // to call checkAcceptability directly, so it never saw the contract-standard
  // blockers and reported a shorter list than acceptance would enforce -- an
  // operator working from `status` was told there was less to do than there was.
  const assessment = assessDraft(draft.value, record.value ?? { claims: [] });
  const { acceptable, blockers } = assessment;

  out.data('draft', name);
  out.data('state', assessment.state);
  out.data('acceptable', acceptable);
  out.data('blockers', blockers);

  out.heading(`Draft "${name}"`);
  if (acceptable) {
    out.ok('Ready to accept.');
    out.blank();
    out.info(`  release-harness accept --draft ${name} --by "<your name>"`);
    return EXIT.OK;
  }

  out.info(describeState(name, assessment));
  out.blank();
  renderBlockers(out, blockers, { fullTextAt: paths(cwd).draft(name) });

  if (blockers.some((b) => b.kind === 'unresolved_question')) {
    out.blank();
    out.info('To resolve a question, add both fields to it in the draft:');
    out.detail('"resolution": "the answer", "resolved_by": "your name"');
  }
  return EXIT.UNPROVEN;
}
