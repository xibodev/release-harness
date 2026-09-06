import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReleaseVersion } from '../../scripts/check-release-version.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const facade = 'packages/release-harness/package.json';
const core = 'packages/release-harness-core/package.json';
const schemas = 'packages/release-harness-schemas/package.json';
const cli = 'packages/release-harness-core/src/cli.js';
const version = JSON.parse(fs.readFileSync(path.join(repo, facade), 'utf8')).version;

test('source metadata agrees for branches and both supported release tag forms', () => {
  for (const ref of ['', 'refs/heads/release/2.0.0', 'refs/pull/1/merge', `refs/tags/v${version}`, `refs/tags/release-harness-v${version}`]) {
    assert.equal(checkReleaseVersion(repo, ref), version);
  }
  for (const ref of ['refs/tags/v0.0.0', 'refs/tags/release-harness-v0.0.0', `refs/tags/${version}`, `refs/tags/v${version}-extra`]) {
    assert.throws(() => checkReleaseVersion(repo, ref), /release tag/);
  }
});

for (const [label, file, mutate, expected] of [
  ['invalid SemVer', facade, (p) => { p.version = '02.0.0'; }, /SemVer/],
  ['invalid prerelease', facade, (p) => { p.version = '2.0.0-01'; }, /SemVer/],
  ['core mismatch', core, (p) => { p.version = '0.0.0'; }, /version mismatch/],
  ['schemas mismatch', schemas, (p) => { p.version = '0.0.0'; }, /version mismatch/],
  ['facade core range', facade, (p) => { p.dependencies['@xibodev/release-harness-core'] = `^${version}`; }, /exact internal pin/],
  ['missing facade schemas', facade, (p) => { delete p.dependencies['@xibodev/release-harness-schemas']; }, /exact internal pin/],
  ['core schemas range', core, (p) => { p.dependencies['@xibodev/release-harness-schemas'] = '*'; }, /exact internal pin/],
  ['Node floor', schemas, (p) => { p.engines.node = '>=18'; }, /Node floor/],
  ['peer floor', facade, (p) => { p.peerDependencies.playwright = '>=1.40.0'; }, /peer floor/],
  ['optional peer', facade, (p) => { p.peerDependenciesMeta.playwright.optional = false; }, /remains optional/],
  ['private root', 'package.json', (p) => { p.private = false; }, /remain private/],
  ['root version', 'package.json', (p) => { p.version = version; }, /independent/],
  ['stale lock', 'package-lock.json', (p) => { p.packages['packages/release-harness'].version = '0.0.0'; }, /lock version/],
  ['stale CLI', cli, (source) => source.replace(/const HARNESS_VERSION = '[^']+';/, "const HARNESS_VERSION = '0.0.0';"), /HARNESS_VERSION/],
]) {
  test(`release guard rejects ${label}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-release-version-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['package.json', 'package-lock.json', facade, core, schemas, cli]) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repo, name), target);
    }
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    if (file === cli) fs.writeFileSync(target, mutate(original));
    else {
      const data = JSON.parse(original);
      mutate(data);
      fs.writeFileSync(target, JSON.stringify(data));
    }
    assert.throws(() => checkReleaseVersion(root, ''), expected);
  });
}
