#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runCli } from '@xibodev/release-harness-core/cli';

// The version comes from this package's own manifest.
//
// It used to be omitted entirely: `runCli()` was called with no options, so the
// CLI fell back to a hardcoded string and the installed package reported a
// version it did not have. The installability test states the consequence --
// it "would seal the wrong engine version into every run manifest", so every
// certificate produced through the published package would misidentify the
// engine that produced it.
const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

runCli(process.argv.slice(2), { version: pkg.version })
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    // Reaching here means the CLI could not report its own failure, which is a
    // harness fault by definition -- never something the subject did.
    console.error(`release-harness crashed: ${err.message}`);
    process.exit(4);
  });
