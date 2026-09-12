// Self-adoption: the product must survive being used on itself.
//
// D35. `release-harness init` in this repository wrote
// `.release-harness/protocol/ADOPTION.md`, and the S-1 invariant -- which
// walked for any ADOPTION.md outside a three-name skip list -- counted it as a
// second AUTHORED protocol. So the suite went red the moment the tool was
// adopted into its own repo, and the only way to get it green again was to
// delete the adoption.
//
// That is a particular kind of defect: the product failing its own dogfood. It
// was found only because one validation run was pointed at the tool itself, and
// nothing in the ordinary gate would ever have exercised it.
//
// The invariant was never wrong -- two editable protocols really is the D9
// defect. Its DEFINITION of "authored" was wrong: it decided authority by
// filesystem position rather than by what makes a file authoritative.
//
// This asserts the property end to end, on a real checkout, because the failure
// only appears when init and the gate meet.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sameCanonicalText } from '../src/canonical-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const BIN = path.join(REPO, 'packages', 'release-harness-core', 'bin', 'release-harness.js');
const INSTALLED = path.join(REPO, '.release-harness');

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nSelf-adoption (D35)\n');

// The repository must not already be adopted, or this proves nothing about
// what init does. If a previous run left one behind, that is itself worth
// failing on rather than quietly working around.
const preExisting = fs.existsSync(INSTALLED);

function cleanup() {
  if (!preExisting && fs.existsSync(INSTALLED)) {
    fs.rmSync(INSTALLED, { recursive: true, force: true });
  }
}

try {
  // -------------------------------------------------------------------------
  // SA-1  init succeeds in the harness's own repository.
  // -------------------------------------------------------------------------
  {
    const r = spawnSync(process.execPath, [BIN, 'init'], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `init must succeed in its own repo:\n${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(INSTALLED), 'init created the installed tree');
    pass('SA-1', 'the harness can be adopted into its own repository');
  }

  // -------------------------------------------------------------------------
  // SA-2  The structural invariants stay green with the adoption present.
  //
  // This is the exact assertion D35 violated. It runs the real suite as a
  // subprocess rather than re-implementing the check, so it cannot drift from
  // what the gate actually enforces.
  // -------------------------------------------------------------------------
  {
    const r = spawnSync(
      process.execPath,
      [path.join(HERE, 'structural-invariants.test.js')],
      { cwd: REPO, encoding: 'utf8' }
    );
    assert.strictEqual(
      r.status,
      0,
      `the structural invariants must survive self-adoption:\n${r.stdout}${r.stderr}`
    );
    pass('SA-2', 'the declared invariants stay green with the tool adopted into itself');
  }

  // -------------------------------------------------------------------------
  // SA-3  The installed protocol is the canonical one, by content.
  //
  // Not by bytes: on Windows the installed copy is written with CRLF endings
  // while the repository ships LF (D32). Comparing bytes there reported the
  // whole file as changed, which is an integrity check that cries wolf.
  // -------------------------------------------------------------------------
  {
    const canonical = fs.readFileSync(path.join(REPO, 'protocol', 'ADOPTION.md'));
    const installed = fs.readFileSync(path.join(INSTALLED, 'protocol', 'ADOPTION.md'));
    assert.ok(
      sameCanonicalText(canonical, installed),
      'the installed protocol must have the same logical identity as the authored one'
    );
    pass('SA-3', 'the installed protocol matches the canonical one under text identity');
  }

  // -------------------------------------------------------------------------
  // SA-4  No second AUTHORITY was created.
  //
  // The installed copy exists; it is simply not source-controlled, and a copy
  // nobody can edit-and-ship is not a rival authority.
  // -------------------------------------------------------------------------
  {
    const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const authored = tracked.filter((f) => path.basename(f) === 'ADOPTION.md');
    assert.deepStrictEqual(
      authored,
      ['protocol/ADOPTION.md'],
      `self-adoption must not add a source-controlled protocol; found: ${authored.join(', ')}`
    );

    const ignored = spawnSync(
      'git',
      ['check-ignore', '.release-harness/protocol/ADOPTION.md'],
      { cwd: REPO, encoding: 'utf8' }
    );
    assert.strictEqual(ignored.status, 0, 'the installed copy must be ignored, not committable');

    pass('SA-4', 'self-adoption adds a copy, never a second authority');
  }

  // -------------------------------------------------------------------------
  // SA-5  init asserted nothing about this project.
  //
  // The same honesty rule every adopter gets: a scaffold may be incomplete, it
  // may not invent intent -- and here the project it could invent things about
  // is the harness itself.
  // -------------------------------------------------------------------------
  {
    const drafts = path.join(INSTALLED, 'drafts');
    const files = fs.existsSync(drafts) ? fs.readdirSync(drafts) : [];
    assert.deepStrictEqual(files, [], 'init must not author a draft about the repository');

    const accepted = path.join(INSTALLED, 'accepted');
    const contracts = fs.existsSync(accepted) ? fs.readdirSync(accepted) : [];
    assert.deepStrictEqual(contracts, [], 'init must not accept anything');

    pass('SA-5', 'init claimed nothing about the harness itself');
  }
} finally {
  cleanup();
}

console.log(`\n  ${results.length} self-adoption checks passed\n`);
