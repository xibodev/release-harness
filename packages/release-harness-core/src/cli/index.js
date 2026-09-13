/**
 * The command surface.
 *
 * Eight operations, derived from the lifecycle rather than from the module
 * names underneath. The vocabulary is deliberately the operator's -- draft,
 * accept, bind, run, verify -- and not the architecture's: nobody needs to know
 * that a "proposition" is canonicalized before it is digested in order to use
 * this.
 *
 * Everything here is plumbing: parse, load, call a core module, render, choose
 * an exit code. No command decides anything a library caller could decide
 * differently, because every judgement lives in core.
 */

import { parseArgs, createOutput } from './io.js';
import { EXIT, EXIT_MEANING } from './exit-codes.js';
import { cmdInit } from './init.js';
import { cmdDraft } from './draft.js';
import { cmdValidate } from './validate.js';
import { cmdAccept } from './accept.js';
import { cmdBind } from './bind.js';
import { cmdRun } from './run.js';
import { cmdVerify } from './verify.js';
import { cmdDoctor } from './doctor.js';

export const COMMANDS = {
  init: { run: cmdInit, summary: 'install the harness; assert nothing about your project' },
  draft: { run: cmdDraft, summary: 'create or inspect a proposal (new, list, status, kinds)' },
  validate: { run: cmdValidate, summary: 'check artifacts against their schemas and semantics' },
  accept: { run: cmdAccept, summary: 'take responsibility for a resolved proposition' },
  bind: { run: cmdBind, summary: 'say where to reach the things a contract names' },
  run: { run: cmdRun, summary: 'exercise a contract (certifying) or a draft (--exploratory)' },
  verify: { run: cmdVerify, summary: "check a run's chain of custody" },
  doctor: { run: cmdDoctor, summary: 'report what exists and whether anything can certify' },
};

/**
 * Per-command help.
 *
 * D16 was every `<command> --help` printing the same global blob, so `bind`'s
 * syntax was discoverable only by reading the protocol document. A command
 * surface a user cannot interrogate is a command surface they have to be told
 * about, which is the same dependency on out-of-band knowledge that the
 * fabrication defects were made of.
 */
const HELP = {
  init: [
    'release-harness init',
    '',
    'Install the harness in this directory. Creates directories, its own config,',
    'and the adoption protocol. Makes NO claims about your software: it does not',
    'inspect your project, name a subject, or guess a port.',
    '',
    '  --force    rewrite harness-owned files if already installed',
  ],
  draft: [
    'release-harness draft new <name>     write an empty proposal',
    'release-harness draft list           show existing drafts',
    'release-harness draft status <name>  what is left to settle',
    'release-harness draft kinds          assertion fields, types and values',
    '',
    'A draft is mutable and may be incomplete -- that is what distinguishes it',
    'from an accepted contract. Edit the two files it creates directly.',
    '',
    'Exit 2 from `status` means valid but not ready to accept.',
  ],
  validate: [
    'release-harness validate [--draft <name>]',
    '',
    'Check artifacts against their schemas and semantics. Reports two different',
    'things: whether a document is well-formed, and whether a draft is ready to',
    'accept. A draft can be perfectly valid and nowhere near ready.',
    '',
    'Exit 0  everything valid and any drafts are ready to accept',
    'Exit 2  valid, but a draft has unresolved blockers',
    'Exit 3  something is actually wrong',
  ],
  accept: [
    'release-harness accept --draft <name> --by "<who>"',
    '',
    'Take responsibility for a resolved proposition. Emits an immutable contract',
    'named by its own digest; the draft is left untouched. Accepting the same',
    'proposition twice keeps one identity and records two acceptance events.',
    '',
    '  --by <who>     required; who is accepting (attribution, not authorization)',
    '  --note <text>  why',
    '  --at <iso>     acceptance timestamp',
  ],
  bind: [
    'release-harness bind <name> --target <symbol>=<location>',
    'release-harness bind                                      list bindings',
    '',
    'Say where to reach the things a contract names. A binding is NOT part of any',
    'promise, so the same contract can be checked locally and in CI without its',
    'identity changing.',
    '',
    '  --target api=http://127.0.0.1:3000    an http target',
    '  --target cli="node ./bin/tool.js"     a command',
    '',
    'Repeat --target for each symbol the contract references.',
  ],
  run: [
    'release-harness run --binding <name> [--contract <digest>]',
    'release-harness run --binding <name> --draft <name> --exploratory',
    '',
    'Exercise a proposition. Mode is decided before anything executes: a run that',
    'cannot certify is refused rather than silently downgraded.',
    '',
    '  --exploratory  run an unaccepted draft for feedback. Never certifies.',
    '',
    'Exit 0  certifying run, everything held',
    'Exit 1  an accepted assertion was violated',
    'Exit 2  nothing was proven (every exploratory run lands here)',
    'Exit 3  usage, contract or binding problem; nothing ran',
    'Exit 4  harness, environment or evidence failure',
  ],
  verify: [
    'release-harness verify [<run-id>]',
    '',
    "Check a run's chain of custody: contract, evidence and verdict, each against",
    'what it claims. A link that cannot be checked is reported as unchecked, never',
    'as passed.',
    '',
    'Exit 2  nothing broken, but the chain is incomplete',
    'Exit 4  a link is broken; the run is not trustworthy',
  ],
  doctor: [
    'release-harness doctor',
    '',
    'Report what exists and whether anything can be certified right now. Prints',
    'facts rather than a summary: "well-formed" means the files parse, which is',
    'not the same as the assertions being true of your software.',
    '',
    'Exit 0  something can be certified',
    'Exit 2  installed, nothing proven',
    'Exit 3  not installed',
  ],
};

function usage(out, version) {
  out.heading(`release-harness ${version}`);
  out.info('An agent-assisted release-contract system with deterministic adjudication.');
  out.blank();
  out.info('Usage: release-harness <command> [options]');
  out.blank();
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    out.info(`  ${name.padEnd(10)} ${cmd.summary}`);
  }
  out.blank();
  out.info('The lifecycle:');
  out.info('  init -> draft -> validate -> accept -> bind -> run -> verify');
  out.blank();
  out.info('Exit codes:');
  for (const [code, meaning] of Object.entries(EXIT_MEANING)) {
    out.info(`  ${code}  ${meaning}`);
  }
  out.blank();
  out.info('Global options:');
  out.info('  --json     emit machine-readable output');
  out.info('  --cwd <p>  operate on a different directory');
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const command = args.positional[0];

  const version = options.version ?? '2.0.0-vnext';
  const json = args.flags.json === true || args.flags.json === 'true';
  const out = options.out ?? createOutput({ json, stream: options.stdout, errStream: options.stderr });
  const cwd = typeof args.flags.cwd === 'string' ? args.flags.cwd : options.cwd ?? process.cwd();

  if (command === 'version' || args.flags.version === true || args.flags.v === true) {
    out.info(version);
    out.data('version', version);
    out.flush();
    return EXIT.OK;
  }

  // A named command claims its own --help before the global handler sees it.
  // D16: `bind --help` printed the global blob, so per-command syntax was
  // discoverable only from the protocol document.
  const wantsHelp = args.flags.help === true || args.flags.h === true;
  if (wantsHelp && COMMANDS[command]) {
    out.heading(`release-harness ${command}`);
    out.info(COMMANDS[command].summary);
    out.blank();
    for (const line of HELP[command] ?? []) out.info(line);
    out.flush();
    return EXIT.OK;
  }

  if (!command || command === 'help' || wantsHelp) {
    usage(out, version);
    out.flush();
    return command || args.flags.help || args.flags.h ? EXIT.OK : EXIT.USAGE_OR_CONTRACT;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    out.error(`Unknown command "${command}".`);
    out.error(`Expected one of: ${Object.keys(COMMANDS).join(', ')}`);
    out.flush();
    return EXIT.USAGE_OR_CONTRACT;
  }

  const ctx = { cwd, out, args, flags: args.flags, version };

  try {
    const code = await handler.run(ctx);
    out.flush({ exit_code: code });
    return code;
  } catch (err) {
    // An unexpected throw is the harness's fault, never the subject's. It must
    // not be reported as anything the product did.
    out.error(`release-harness failed: ${err.message}`);
    if (args.flags.debug) out.error(err.stack);
    out.flush({ exit_code: EXIT.HARNESS_OR_INTEGRITY });
    return EXIT.HARNESS_OR_INTEGRITY;
  }
}
