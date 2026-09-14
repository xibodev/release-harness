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
import { fileURLToPath } from 'node:url';
import { canonicalText } from '../canonical-text.js';
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
function defaultConfig(version, { lifecycle = false } = {}) {
  return {
    schema_version: '1.0.0',
    harness_version: version,
    // How long a run may take before the harness gives up and says so. A
    // harness-owned default: it constrains us, not the subject.
    run_timeout_ms: 600000,
    // Whether a dirty working tree downgrades eligibility. On by default
    // because certifying a tree you cannot reproduce is not certification.
    require_clean_source: true,
    ...(lifecycle ? { lifecycle: { enabled: true, provider: 'git' } } : {}),
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

const MANAGED_START = '<!-- release-harness:managed:start -->';
const MANAGED_END = '<!-- release-harness:managed:end -->';
const MANAGED = `${MANAGED_START}
When work affects tests, public behavior, packaging, build/release configuration,
deployment inputs, compatibility boundaries, or normative dependencies, load the
project Release-Harness capability. Read existing Release-Harness state before
reasoning from the repository. Perform change-impact review before claiming
release readiness.
${MANAGED_END}`;

const ADAPTER = `---
name: release-harness
description: Operate the continuous Release-Harness lifecycle across sessions and releases.
---

# Release-Harness lifecycle

Read \`.release-harness/protocol/LIFECYCLE.md\` and follow it. Run
\`release-harness lifecycle status\` first. Use only the public CLI; the
deterministic core remains authoritative. This adapter owns no product semantics.
`;

function installManagedInstruction(cwd) {
  const file = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const pattern = new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}`, 'g');
  const updated = pattern.test(existing)
    ? existing.replace(pattern, MANAGED)
    : `${existing.replace(/\\s*$/, '')}${existing.trim() ? '\\n\\n' : ''}${MANAGED}\\n`;
  fs.writeFileSync(file, updated);
}

function installAgentCapability(cwd, lifecycleSource) {
  for (const target of [
    path.join(cwd, '.agents', 'skills', 'release-harness', 'SKILL.md'),
    path.join(cwd, '.claude', 'skills', 'release-harness', 'SKILL.md'),
  ]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ADAPTER);
  }
  installManagedInstruction(cwd);
  if (lifecycleSource) {
    const target = path.join(paths(cwd).root, 'protocol', 'LIFECYCLE.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(lifecycleSource, target);
  }
}

export function cmdInit(ctx) {
  const { cwd, out, version } = ctx;
  const p = paths(cwd);

  const withAgent = ctx.flags.withAgent === true || ctx.flags.withAgent === 'true';
  const legacyIndicators = [
    'topology.json',
    'origins.json',
    'harness.config.json',
    'scenarios',
  ].filter((name) => fs.existsSync(path.join(p.root, name)));
  if (legacyIndicators.length > 0) {
    out.error(`Legacy topology-era state detected: ${legacyIndicators.join(', ')}`);
    out.error('These values are investigation leads, not evidence. Archive them explicitly before initializing the current model.');
    out.data('legacy', legacyIndicators);
    return EXIT.UNPROVEN;
  }

  if (isInstalled(cwd) && !ctx.flags.force && !withAgent) {
    out.info(`release-harness is already installed in ${path.relative(cwd, p.root) || '.'}`);
    out.info('Nothing to do. Pass --force to rewrite harness-owned files.');
    return EXIT.OK;
  }

  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(path.join(p.root, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(p.root, 'examples'), { recursive: true });

  writeJson(p.config, defaultConfig(version, { lifecycle: withAgent }));
  fs.writeFileSync(path.join(p.root, 'README.md'), README);

  // Examples live in their own directory, outside every location a command
  // reads from. An example that sits where a contract is loaded is not an
  // example, it is a fabricated contract with a disclaimer.
  writeJson(path.join(p.root, 'examples', 'example.draft.json'), EXAMPLE);
  writeJson(path.join(p.root, 'examples', 'example.record.json'), EXAMPLE_RECORD);

  // The authoring protocol, copied so an agent on any host can read it. Note
  // what this does NOT establish: whether a host has loaded it. A file on disk
  // is not proof a capability is active, and `doctor` reports the two facts
  // separately for exactly that reason.
  // One canonical protocol, two places it can live depending on how this code
  // was reached: `generated/` in a packed install, and the repo's own
  // `protocol/` when running from a checkout. Both are copies OF the same
  // authored file -- `generated/` is produced by scripts/sync-protocol.mjs and
  // is git-ignored, so there is exactly one file a developer can edit.
  //
  // D9 was two AUTHORED copies. A fix landed in one of them and every adopter
  // received the other for as long as nobody compared them.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const protocolSource = [
    path.join(here, '..', '..', 'generated', 'protocol', 'ADOPTION.md'),
    path.join(here, '..', '..', '..', '..', 'protocol', 'ADOPTION.md'),
  ].find((candidate) => fs.existsSync(candidate));
  let protocolInstalled = false;
  if (protocolSource) {
    fs.mkdirSync(path.join(p.root, 'protocol'), { recursive: true });
    fs.copyFileSync(protocolSource, path.join(p.root, 'protocol', 'ADOPTION.md'));
    protocolInstalled = true;
  }

  const lifecycleSource = [
    path.join(here, '..', '..', 'generated', 'protocol', 'LIFECYCLE.md'),
    path.join(here, '..', '..', '..', '..', 'protocol', 'LIFECYCLE.md'),
  ].find((candidate) => fs.existsSync(candidate));
  if (withAgent) installAgentCapability(cwd, lifecycleSource);

  out.ok(`Installed release-harness in ${path.relative(cwd, p.root) || '.'}`);
  out.blank();
  out.info('No contract exists yet, and nothing here describes your software.');
  out.info('release-harness does not inspect your project or guess what it does.');
  out.blank();
  out.info('Next:');
  out.info('  release-harness draft new <name>     write what must hold');
  out.info('  release-harness doctor               see where you stand');
  if (withAgent) {
    out.blank();
    out.info('Continuous lifecycle enabled. One provider-neutral capability was installed.');
    out.info('Future sessions begin with: release-harness lifecycle status');
  }
  if (protocolInstalled) {
    out.blank();
    out.info('An agent can help you author a draft. Point it at:');
    out.info(`  ${path.join(path.relative(cwd, p.root) || '.', 'protocol', 'ADOPTION.md')}`);
  }

  return EXIT.OK;
}
