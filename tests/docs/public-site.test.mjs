import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SITE_FILES, buildPublicSite } from '../../scripts/build-public-site.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docs = path.join(repo, 'docs');
const publicFiles = ['app.js', 'docs.html', 'index.html', 'style.css'];
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.startsWith('#')) {
      return String.fromCodePoint(entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1)));
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

const attributes = (html, name) => [...html.matchAll(
  new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'gi')
)].map((match) => decode(match[2]));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-beta-site-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, output: path.join(root, '_site') };
}

function checkLocalLink(from, href, root, artifactOnly = false) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
  const url = new URL(href, `https://docs.invalid/${path.relative(root, from).split(path.sep).join('/')}`);
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
  if (artifactOnly) assert.ok(publicFiles.includes(relative), `${from}: unpublished target ${href}`);
  const target = path.join(root, relative);
  assert.ok(fs.existsSync(target), `${from}: missing target ${href}`);
  if (!url.hash) return;
  const ids = path.extname(target).toLowerCase() === '.md'
    ? [...fs.readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map((match) => match[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-'))
    : attributes(fs.readFileSync(target, 'utf8'), 'id');
  assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `${from}: missing fragment ${href}`);
}

test('public artifact is exactly the four byte-identical allowlisted files', (t) => {
  const { output } = fixture(t);
  assert.ok(Object.isFrozen(PUBLIC_SITE_FILES));
  assert.deepEqual([...PUBLIC_SITE_FILES].sort(), publicFiles);
  buildPublicSite({ sourceDir: docs, outputDir: output });
  assert.deepEqual(fs.readdirSync(output).sort(), publicFiles);
  for (const name of publicFiles) {
    assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(docs, name)));
  }
});

test('site builder replaces stale output without publishing nested files', (t) => {
  const { root, output } = fixture(t);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'stale.txt'), 'must disappear');
  buildPublicSite({ sourceDir: docs, outputDir: output });
  assert.deepEqual(fs.readdirSync(output).sort(), publicFiles);
  assert.equal(fs.existsSync(path.join(output, 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(output, 'superpowers')), false);
  assert.equal(fs.existsSync(path.join(output, 'private')), false);
  assert.ok(fs.existsSync(root));
});

test('all site-local assets and fragments resolve inside the artifact', () => {
  for (const name of ['index.html', 'docs.html']) {
    const file = path.join(docs, name);
    const html = fs.readFileSync(file, 'utf8');
    const ids = attributes(html, 'id');
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IDs`);
    for (const href of [...attributes(html, 'href'), ...attributes(html, 'src')]) {
      checkLocalLink(file, href, docs, true);
    }
  }
});

test('repository Markdown links resolve locally', () => {
  for (const name of ['README.md', 'BETA-RELEASE-NOTES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    const text = read(name).replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      checkLocalLink(path.join(repo, name), match[1], repo);
    }
  }
});

test('public docs describe the beta and only the current command surface', () => {
  const version = JSON.parse(read('packages/release-harness/package.json')).version;
  assert.equal(version, '1.2.0-beta.1');
  const forbidden = /\b(?:run-local|check-pr|release-conductor|scenario-compiler|fix-planner|fix-executor)\b|topology\.json|origins\.json/;
  for (const name of ['README.md', 'BETA-RELEASE-NOTES.md', 'docs/index.html', 'docs/docs.html']) {
    const text = read(name);
    assert.ok(text.includes(version), `${name}: beta version`);
    assert.doesNotMatch(text, forbidden, `${name}: deleted architecture`);
  }
  assert.doesNotMatch(read('SECURITY.md'), forbidden, 'SECURITY.md: deleted architecture');
  for (const command of ['init', 'draft', 'validate', 'accept', 'bind', 'run', 'verify']) {
    assert.ok(read('README.md').includes(command), `README: ${command}`);
    assert.ok(read('docs/docs.html').includes(command), `docs: ${command}`);
  }
  assert.match(read('README.md'), /publicly available.*beta/i);
  assert.match(read('docs/docs.html'), /BETA, NOT STABLE/);
});

test('manual and agent-assisted adoption share one frozen model', () => {
  for (const name of ['README.md', 'BETA-RELEASE-NOTES.md', 'docs/docs.html']) {
    const text = read(name);
    assert.match(text, /subject\s*\+\s*assertions\s*\+\s*requires\s*\+\s*execution bindings/i, name);
    assert.doesNotMatch(text, /"topology_type"|"repository_role"|"component_registry"/i, name);
  }
  const docsText = read('docs/docs.html');
  assert.match(docsText, /agent.*same.*contract|same.*artifacts/i);
  assert.match(docsText, /deterministic core decides/i);
});

test('documentation JavaScript parses', () => {
  const result = spawnSync(process.execPath, ['--check', path.join(docs, 'app.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
