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
const CANONICAL = path.join(REPO, 'protocol', 'ADOPTION.md');
const OUT_DIR = path.join(REPO, 'packages', 'release-harness-core', 'generated', 'protocol');

if (!fs.existsSync(CANONICAL)) {
  console.error(`sync-protocol: canonical protocol missing at ${CANONICAL}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(CANONICAL, path.join(OUT_DIR, 'ADOPTION.md'));
console.log(`sync-protocol: ${path.relative(REPO, CANONICAL)} -> generated/protocol/ADOPTION.md`);
