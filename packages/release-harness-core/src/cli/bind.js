/**
 * `bind` -- say where to go and look.
 *
 * A binding is not part of any promise. It is the thing that lets one accepted
 * contract be checked against localhost and against staging without its
 * identity moving, which is what makes a contract authored on a laptop
 * certifiable in CI.
 *
 * They are stored as separate files for the same reason they are a separate
 * type: the previous architecture folded topology and origins into the same
 * hashed unit as the assertions, so changing a port changed the identity of the
 * proposition. Keeping them apart on disk makes that mistake harder to make
 * again than any comment could.
 */

import { paths, writeJson, readJson, listBindings, isInstalled } from './layout.js';
import { EXIT } from './exit-codes.js';
import { asList } from './io.js';

export function cmdBind(ctx) {
  const { cwd, out, args } = ctx;

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);
  const name = args.positional[1];

  if (!name) {
    const names = listBindings(cwd);
    out.data('bindings', names);
    if (names.length === 0) {
      out.info('No bindings yet.');
      out.blank();
      out.info('  release-harness bind local --target api=http://127.0.0.1:3000');
      return EXIT.OK;
    }
    out.heading(`${names.length} binding${names.length === 1 ? '' : 's'}`);
    for (const n of names) {
      const doc = readJson(p.binding(n));
      out.info(n);
      for (const [k, v] of Object.entries(doc.value?.targets ?? {})) out.detail(`${k} -> ${v}`);
    }
    return EXIT.OK;
  }

  const targets = {};
  for (const entry of asList(args.flags.target)) {
    const eq = String(entry).indexOf('=');
    if (eq < 1) {
      out.error(`Cannot read target "${entry}". Expected <symbol>=<location>, e.g. api=http://127.0.0.1:3000`);
      return EXIT.USAGE_OR_CONTRACT;
    }
    targets[String(entry).slice(0, eq)] = String(entry).slice(eq + 1);
  }

  if (Object.keys(targets).length === 0) {
    out.error('Usage: release-harness bind <name> --target <symbol>=<location> [--target ...]');
    out.error('The symbol is the "target" named by an assertion; the location is where to reach it.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const file = p.binding(name);
  writeJson(file, { schema_version: '1.0.0', targets });

  out.data('binding', name);
  out.data('targets', targets);

  out.ok(`Bound "${name}"`);
  for (const [k, v] of Object.entries(targets)) out.detail(`${k} -> ${v}`);
  out.blank();
  out.info('A binding is not part of the contract, so changing it does not change');
  out.info('what was promised. The same contract can have as many as you need.');
  out.blank();
  out.info('Next:');
  out.info(`  release-harness run --binding ${name}`);

  return EXIT.OK;
}
