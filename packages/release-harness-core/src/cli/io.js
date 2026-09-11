/**
 * Output and argument parsing. Deliberately dull.
 *
 * The CLI's whole job is to parse, load, call core, render, and pick an exit
 * code. Every judgement lives in a core module, so that the same decision
 * cannot be made one way by a command and another way by a library caller.
 */

/** Rendering, with a --json mode that emits one machine-readable object. */
export function createOutput({ json = false, stream = process.stdout, errStream = process.stderr } = {}) {
  const lines = [];
  const record = {};

  const write = (s) => {
    if (!json) stream.write(s + '\n');
  };

  return {
    get json() {
      return json;
    },
    ok: (msg) => write(`  ${msg}`),
    info: (msg) => write(msg ? `  ${msg}` : ''),
    detail: (msg) => write(`    ${msg}`),
    blank: () => write(''),
    heading: (msg) => {
      write('');
      write(msg);
      write('');
    },
    /** A problem the user must act on. Always goes to stderr, json or not. */
    error: (msg) => {
      if (json) lines.push(msg);
      else errStream.write(`  ${msg}\n`);
    },
    /** Accumulate structured data for --json. */
    data: (key, value) => {
      record[key] = value;
    },
    /** Emit the structured payload, if in json mode. */
    flush: (extra = {}) => {
      if (!json) return;
      const payload = { ...record, ...extra };
      if (lines.length > 0) payload.errors = lines;
      stream.write(JSON.stringify(payload, null, 2) + '\n');
    },
  };
}

/**
 * Parse `--flag`, `--key value`, `--key=value` and positionals.
 *
 * Repeated keys collect into an array, which is what lets `--binding` be given
 * more than once without a separate syntax.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');

    let key;
    let value;
    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (camel in flags) {
      flags[camel] = Array.isArray(flags[camel]) ? [...flags[camel], value] : [flags[camel], value];
    } else {
      flags[camel] = value;
    }
  }

  return { positional, flags };
}

/** Always an array, so callers need not branch on how many times a flag appeared. */
export function asList(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}
