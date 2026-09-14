#!/usr/bin/env node
/**
 * Copy the canonical adoption protocol into the package's generated directory.
 *
 * This exists because npm cannot package a file outside its package root, so
 * the published tarball needs a physical copy. What it must NOT need is a
 * second AUTHORED copy -- that was D9: two independently editable files, a fix
 * applied to one of them, and every adopter receiving the stale one for as long
 * as nobody noticed.
 *
 * So the copy is generated, and `generated/` is git-ignored. There is exactly
 * one file a developer can edit. If this script stops running, the packed
 * package is missing its protocol and the installability test fails loudly --
 * which is the failure you want, rather than a silently stale copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOLS = ['ADOPTION.md', 'LIFECYCLE.md'];
const OUT_DIR = path.join(REPO, 'packages', 'release-harness-core', 'generated', 'protocol');

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of PROTOCOLS) {
  const canonical = path.join(REPO, 'protocol', name);
  if (!fs.existsSync(canonical)) {
    console.error(`sync-protocol: canonical protocol missing at ${canonical}`);
    process.exit(1);
  }
  fs.copyFileSync(canonical, path.join(OUT_DIR, name));
  console.log(`sync-protocol: ${path.relative(REPO, canonical)} -> generated/protocol/${name}`);
}
