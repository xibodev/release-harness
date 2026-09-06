#!/usr/bin/env node

import { runCli } from '../src/cli.js';

runCli()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exitCode = 3;
  });
