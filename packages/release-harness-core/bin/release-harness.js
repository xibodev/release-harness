#!/usr/bin/env node

import { runCli } from '../src/cli.js';

runCli()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(3);
  });
