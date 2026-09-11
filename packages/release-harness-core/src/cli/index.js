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
  draft: { run: cmdDraft, summary: 'create or inspect a proposal (new, list, status)' },
  validate: { run: cmdValidate, summary: 'check artifacts against their schemas and semantics' },
  accept: { run: cmdAccept, summary: 'take responsibility for a resolved proposition' },
  bind: { run: cmdBind, summary: 'say where to reach the things a contract names' },
  run: { run: cmdRun, summary: 'exercise a contract (certifying) or a draft (--exploratory)' },
  verify: { run: cmdVerify, summary: "check a run's chain of custody" },
  doctor: { run: cmdDoctor, summary: 'report what exists and whether anything can certify' },
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

  if (!command || command === 'help' || args.flags.help === true || args.flags.h === true) {
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
