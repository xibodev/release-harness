#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

runCli(process.argv.slice(2), { version: pkg.version })
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    // Reaching here means the CLI could not even report its own failure, which
    // is a harness fault by definition -- never something the subject did.
    console.error(`release-harness crashed: ${err.message}`);
    process.exit(4);
  });
