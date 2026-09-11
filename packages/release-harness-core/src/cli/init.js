/**
 * `init` -- install the harness, and assert nothing about the project.
 *
 * The previous implementation of this command is the reason the architecture
 * was replaced. It wrote a topology claiming a browser app on port 3000, into
 * repositories that contained no such thing, and `doctor` then reported that
 * fabrication as valid and the installation as Ready. A newcomer had no shipped
 * signal distinguishing "these contracts describe my product" from "these
 * contracts describe a product that does not exist."
 *
 * So this command may create only things that are true BECAUSE it created them:
 * directories, its own config, and material that is obviously an example. It
 * may not name a subject, guess a port, invent a URL, assume a repository
 * layout, describe an auth model, or write anything into a location where a
 * runtime contract is read from.
 *
 * The rule is easy to state and easy to check: after `init`, nothing exists
 * that makes a claim about the software being released. Everything a contract
 * eventually says has to be put there by a person who knows it to be true.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, DIRS, writeJson, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';

/**
 * Harness-owned configuration.
 *
 * Every value here is about the harness itself. There is deliberately no
 * `subject`, no `product`, no `name`, no `port` and no `url` -- not even set to
 * null, because an empty field invites being filled in with a guess, and a
 * guess written by the tool is indistinguishable on disk from a fact
 * established by a person.
 */
function defaultConfig(version) {
  return {
    schema_version: '1.0.0',
    harness_version: version,
    // How long a run may take before the harness gives up and says so. A
    // harness-owned default: it constrains us, not the subject.
    run_timeout_ms: 600000,
    // Whether a dirty working tree downgrades eligibility. On by default
    // because certifying a tree you cannot reproduce is not certification.
    require_clean_source: true,
  };
}

const README = `# .release-harness

This directory holds your release contracts. release-harness created it and
made no claims about your software -- everything below is authored by you.

    drafts/     What you are still working out. Mutable; edit freely.
    accepted/   What you have committed to. Each file is named by its own
                digest, so a contract cannot be changed without becoming a
                different contract.
    bindings/   Where to go and look: ports, URLs, commands. Deliberately NOT
                part of any promise, so the same contract can be checked
                locally and in CI without its identity changing.
    runs/       What happened, sealed.

Start with:

    release-harness draft new <name>

That writes an empty draft for you to fill in. release-harness will not guess
what your software does; if it did, you would have no way to tell its guesses
apart from your own knowledge.
`;

/** An example, stored where it cannot be mistaken for a contract of yours. */
const EXAMPLE = {
  _comment:
    'An EXAMPLE. It describes a fictional service and is never read at run time. ' +
    'Copy it to drafts/ and edit, or run `release-harness draft new <name>`.',
  schema_version: '1.0.0',
  proposition: {
    subject: { id: 'example-service', name: 'Example Service' },
    assertions: [
      {
        id: 'A1',
        kind: 'http',
        target: 'api',
        description: 'the service reports itself healthy',
        expect: { method: 'GET', path: '/health', status: 200 },
        supported_by: ['health-endpoint'],
      },
    ],
  },
  questions: [
    {
      id: 'Q1',
      question: 'Does /health check dependencies, or only that the process is up?',
      blocking: true,
    },
  ],
};

const EXAMPLE_RECORD = {
  _comment: 'The authoring record for the example draft. Never read at run time.',
  schema_version: '1.0.0',
  authored_by: 'you',
  claims: [
    {
      id: 'health-endpoint',
      claim: 'the service exposes GET /health returning 200',
      status: 'observed',
      evidence: { source: 'src/server.js:41' },
    },
  ],
};

export function cmdInit(ctx) {
  const { cwd, out, version } = ctx;
  const p = paths(cwd);

  if (isInstalled(cwd) && !ctx.flags.force) {
    out.info(`release-harness is already installed in ${path.relative(cwd, p.root) || '.'}`);
    out.info('Nothing to do. Pass --force to rewrite harness-owned files.');
    return EXIT.OK;
  }

  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(path.join(p.root, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(p.root, 'examples'), { recursive: true });

  writeJson(p.config, defaultConfig(version));
  fs.writeFileSync(path.join(p.root, 'README.md'), README);

  // Examples live in their own directory, outside every location a command
  // reads from. An example that sits where a contract is loaded is not an
  // example, it is a fabricated contract with a disclaimer.
  writeJson(path.join(p.root, 'examples', 'example.draft.json'), EXAMPLE);
  writeJson(path.join(p.root, 'examples', 'example.record.json'), EXAMPLE_RECORD);

  out.ok(`Installed release-harness in ${path.relative(cwd, p.root) || '.'}`);
  out.blank();
  out.info('No contract exists yet, and nothing here describes your software.');
  out.info('release-harness does not inspect your project or guess what it does.');
  out.blank();
  out.info('Next:');
  out.info('  release-harness draft new <name>     write what must hold');
  out.info('  release-harness doctor               see where you stand');

  return EXIT.OK;
}
