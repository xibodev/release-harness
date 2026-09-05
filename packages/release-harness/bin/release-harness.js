#!/usr/bin/env node

import { runCli } from '@xibodev/release-harness-core/cli';

runCli()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error('Fatal Release-Harness Error:', err);
    process.exitCode = 3;
  });
