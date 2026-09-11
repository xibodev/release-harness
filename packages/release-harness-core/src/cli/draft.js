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
import { checkAcceptability } from '../draft.js';

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
  out.info('Each claim carries a status, and each status needs its own evidence:');
  out.detail('observed          you read it -- needs evidence.source ("src/app.js:41")');
  out.detail('observed_absent   a COMPLETED bounded search found nothing -- needs');
  out.detail('                  evidence.method, evidence.roots, evidence.completed: true');
  out.detail('asserted_absent   something requires it not to exist -- needs');
  out.detail('                  evidence.asserted_by ("tests/test_no_v1.js:11")');
  out.detail('inferred          you worked it out -- needs evidence.source, and cannot');
  out.detail('                  support an accepted assertion');
  out.detail('not_established   the search never finished -- needs nothing, supports nothing');
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

  const { acceptable, blockers } = checkAcceptability(draft.value, record.value ?? { claims: [] });

  out.data('draft', name);
  out.data('acceptable', acceptable);
  out.data('blockers', blockers);

  out.heading(`Draft "${name}"`);
  if (acceptable) {
    out.ok('Ready to accept.');
    out.blank();
    out.info(`  release-harness accept --draft ${name} --by "<your name>"`);
    return EXIT.OK;
  }

  out.info(`Not ready to accept -- ${blockers.length} thing${blockers.length === 1 ? '' : 's'} to settle:`);
  out.blank();
  for (const b of blockers) out.info(`  [${b.kind}] ${b.detail}`);
  return EXIT.UNPROVEN;
}
