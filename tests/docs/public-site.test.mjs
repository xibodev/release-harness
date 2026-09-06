import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SITE_FILES, buildPublicSite } from '../../scripts/build-public-site.mjs';
import { Schemas } from '../../packages/release-harness-schemas/index.js';
import { validateAgainstSchema } from '../../packages/release-harness-core/src/validator.js';
import { readBundledSkills } from '../../packages/release-harness-core/src/cli.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docs = path.join(repo, 'docs');
const files = ['app.js', 'docs.html', 'index.html', 'style.css'];
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');
const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  if (entity.startsWith('#')) return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
});
const plain = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attributes = (html, name) => [...html.matchAll(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'gi'))].map((match) => decode(match[2]));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-public-site-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const sourceDir = path.join(root, 'docs');
  const outputDir = path.join(root, '_site');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(outputDir);
  for (const name of files) fs.copyFileSync(path.join(docs, name), path.join(sourceDir, name));
  fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'existing output');
  return { root, sourceDir, outputDir };
}

function link(t, target, destination, directory = true) {
  try {
    fs.symlinkSync(target, destination, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.skip(`Host cannot create ${directory ? 'directory' : 'file'} links: ${error.code}`);
    return false;
  }
}

test('public artifact contains exactly four byte-identical source files', (t) => {
  const { outputDir } = fixture(t);
  assert.ok(Object.isFrozen(PUBLIC_SITE_FILES));
  assert.deepEqual([...PUBLIC_SITE_FILES].sort(), files);
  assert.equal(buildPublicSite({ sourceDir: docs, outputDir }), outputDir);
  assert.deepEqual(fs.readdirSync(outputDir).sort(), files);
  for (const name of files) {
    assert.ok(fs.lstatSync(path.join(outputDir, name)).isFile());
    assert.deepEqual(fs.readFileSync(path.join(outputDir, name)), fs.readFileSync(path.join(docs, name)));
  }
});

test('rebuild removes stale output and excludes nested private source fixtures', (t) => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.sourceDir, 'private', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(options.sourceDir, 'private', 'nested', 'sentinel.md'), 'synthetic private sentinel');
  fs.writeFileSync(path.join(options.sourceDir, 'unlisted.md'), 'not a public asset');
  buildPublicSite(options);
  fs.mkdirSync(path.join(options.outputDir, 'stale'));
  fs.writeFileSync(path.join(options.outputDir, 'stale', 'sentinel.md'), 'stale artifact');
  buildPublicSite(options);
  assert.deepEqual(fs.readdirSync(options.outputDir).sort(), files);
  assert.equal(fs.readFileSync(path.join(options.sourceDir, 'private', 'nested', 'sentinel.md'), 'utf8'), 'synthetic private sentinel');
});

for (const invalid of ['missing', 'directory', 'linked']) {
  test(`${invalid} public input is rejected before existing output is cleared`, (t) => {
    const options = fixture(t);
    const input = path.join(options.sourceDir, 'app.js');
    fs.unlinkSync(input);
    if (invalid === 'directory') fs.mkdirSync(input);
    if (invalid === 'linked' && !link(t, path.join(docs, 'app.js'), input, false)) return;
    assert.throws(() => buildPublicSite(options), /ENOENT|regular file|link/i);
    assert.deepEqual(fs.readdirSync(options.outputDir), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(options.outputDir, 'keep.txt'), 'utf8'), 'existing output');
  });
}

for (const kind of ['same directory', 'source parent']) {
  test(`output cannot be ${kind}`, (t) => {
    const options = fixture(t);
    const before = fs.readFileSync(path.join(options.sourceDir, 'index.html'));
    options.outputDir = kind === 'same directory' ? options.sourceDir : options.root;
    assert.throws(() => buildPublicSite(options), /source directory/);
    assert.deepEqual(fs.readFileSync(path.join(options.sourceDir, 'index.html')), before);
  });
}

for (const ancestor of [false, true]) {
  test(`linked ${ancestor ? 'ancestor of source' : 'source directory'} is rejected without clearing output`, (t) => {
    const options = fixture(t);
    const alias = path.join(options.root, 'alias');
    if (!link(t, ancestor ? options.root : options.sourceDir, alias)) return;
    assert.throws(() => buildPublicSite({ ...options, sourceDir: ancestor ? path.join(alias, 'docs') : alias }), /link/i);
    assert.equal(fs.readFileSync(path.join(options.outputDir, 'keep.txt'), 'utf8'), 'existing output');
  });
}

for (const kind of ['output', 'output ancestor', 'dangling output']) {
  test(`linked ${kind} is rejected without modifying the link or target`, (t) => {
    const options = fixture(t);
    const alias = path.join(options.root, 'alias');
    const target = kind === 'dangling output' ? path.join(options.root, 'absent') : options.outputDir;
    if (!link(t, target, alias)) return;
    const before = fs.readlinkSync(alias);
    assert.throws(() => buildPublicSite({ ...options, outputDir: kind === 'output ancestor' ? path.join(alias, 'child') : alias }), /link/i);
    assert.equal(fs.readlinkSync(alias), before);
    assert.deepEqual(fs.readdirSync(options.outputDir), ['keep.txt']);
    assert.equal(fs.existsSync(path.join(options.outputDir, 'child')), false);
    assert.equal(fs.existsSync(path.join(options.root, 'absent')), false);
  });
}

test('an existing regular file is not a disposable output directory', (t) => {
  const options = fixture(t);
  const outputDir = path.join(options.root, 'not-a-directory');
  fs.writeFileSync(outputDir, 'preserve me');
  assert.throws(() => buildPublicSite({ ...options, outputDir }), /directory|ENOTDIR/i);
  assert.equal(fs.readFileSync(outputDir, 'utf8'), 'preserve me');
});

function checkLink(from, href, root, artifactOnly = false) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
  const url = new URL(href, `https://docs.invalid/${path.relative(root, from).split(path.sep).join('/')}`);
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
  const target = path.join(root, relative);
  if (artifactOnly) assert.ok(files.includes(relative), `${from}: unpublished target ${href}`);
  assert.ok(fs.existsSync(target), `${from}: missing local target ${href}`);
  if (!url.hash) return;
  const content = fs.readFileSync(target, 'utf8');
  const ids = path.extname(target) === '.md'
    ? [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-'))
    : attributes(content, 'id');
  assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `${from}: missing fragment ${href}`);
}

test('all local HTML/CSS assets and fragments resolve inside the artifact', () => {
  for (const name of ['index.html', 'docs.html']) {
    const file = path.join(docs, name);
    const html = fs.readFileSync(file, 'utf8');
    const ids = attributes(html, 'id');
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IDs`);
    for (const href of [...attributes(html, 'href'), ...attributes(html, 'src')]) checkLink(file, href, docs, true);
  }
  for (const match of read('docs/style.css').matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) {
    checkLink(path.join(docs, 'style.css'), match[1], docs, true);
  }
});

test('README, contributor and security Markdown links resolve locally', () => {
  for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    const text = read(name).replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) checkLink(path.join(repo, name), match[1], repo);
  }
});

test('all seven copyable JSON contracts validate against source schemas', () => {
  const examples = new Map();
  for (const match of read('docs/docs.html').matchAll(/<pre\b([^>]*)>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g)) {
    const text = decode(match[2]).trim();
    if (!/^[\[{]/.test(text)) continue;
    const [name] = attributes(match[1], 'data-contract');
    assert.ok(name, 'JSON example needs a data-contract schema reference');
    assert.ok(!examples.has(name), `duplicate JSON example ${name}`);
    examples.set(name, JSON.parse(text));
  }
  assert.deepEqual([...examples.keys()].sort(), ['config-fragment', 'custom-fragment', 'negative-fragment', 'origins', 's3-fragment', 'scenario', 'topology']);
  const version = JSON.parse(read('packages/release-harness-core/package.json')).version;
  for (const [name, value] of examples) {
    let schema, data = value;
    if (name === 'topology') schema = Schemas.TopologyV1;
    else if (name === 'origins') schema = Schemas.OriginsV1;
    else if (name === 'config-fragment') {
      schema = Schemas.HarnessConfigV1;
      data = { schema_version: '1.0.0', harness_version: version, product_slug: examples.get('topology').product_slug, port_block: { start: 43000, range: 50 }, ...value };
    } else {
      schema = Schemas.ScenarioV1;
      data = { ...examples.get('scenario'), ...value };
    }
    validateAgainstSchema(schema, data, `docs example ${name}`);
  }
  assert.ok(examples.get('origins').some((origin) => origin.origin_id === examples.get('scenario').origin_id));
  for (const node of examples.get('topology').nodes) {
    if (node.served_origin_id) assert.ok(examples.get('origins').some((origin) => origin.origin_id === node.served_origin_id));
  }
  assert.ok(Object.hasOwn(examples.get('s3-fragment').expected_side_effects[0].params, 'key'));
  assert.ok(!Object.hasOwn(examples.get('s3-fragment').expected_side_effects[0].params, 'key_prefix'));
});

test('landing page identifies the product, installation and both onboarding paths', () => {
  const html = read('docs/index.html');
  assert.match(plain(html), /Release-Harness/i);
  assert.match(plain(html), /npm install -D @xibodev\/release-harness/);
  const links = attributes(html, 'href');
  assert.ok(links.includes('docs.html#installation'));
  assert.ok(links.includes('docs.html#ai-agent-onboarding'));
});

test('reference documentation covers commands, evidence, AI and supported boundaries', () => {
  const html = read('docs/docs.html');
  const sections = new Map([...html.matchAll(/<section\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((match) => [match[1], plain(match[2])]));
  for (const id of ['installation', 'ai-agent-onboarding', 'use-modes', 'cli-commands', 'project-contracts', 'scenario-dsl', 'playwright-adapter-guide', 'ci-usage', 'core-invariants', 'architecture-pipeline', 'contributing', 'roadmap-levels', 'upgrades', 'troubleshooting']) {
    assert.ok(sections.get(id), `missing documentation section ${id}`);
  }
  for (const command of ['doctor', 'init', 'skills list', 'skills info', 'check-pr', 'run-local', 'evaluate', 'clean']) assert.ok(sections.get('cli-commands').includes(command), command);
  for (const [code, status] of ['PASS', 'FAIL', 'UNPROVEN', 'HARNESS_ERROR', 'EVIDENCE_INVALID'].entries()) assert.ok(sections.get('core-invariants').includes(`${status} ${code}`), `${status} exit ${code}`);
  assert.match(sections.get('core-invariants'), /EVIDENCE_INVALID.*[Pp]reserve.*investigate/);
  assert.match(sections.get('core-invariants'), /verdict\.json/);
  assert.match(sections.get('core-invariants'), /run\.manifest\.json/);
  assert.match(sections.get('playwright-adapter-guide'), /not wired into run-local/);
  assert.match(sections.get('playwright-adapter-guide'), /not copied or sealed/);
  assert.match(sections.get('scenario-dsl'), /sql_query.*not implemented/);
  const ai = sections.get('ai-agent-onboarding');
  assert.match(ai, /init --with-agents/);
  assert.match(ai, /host registration/);
  for (const name of ['project-cartographer', 'scenario-compiler']) assert.ok(ai.includes(`release-harness-${name}`));
  assert.ok(ai.includes(`${readBundledSkills().length} playbooks`), 'skill count must match source metadata');
  assert.match(ai, /cannot replace the deterministic CLI/);
  assert.match(sections.get('architecture-pipeline'), /SECURITY|security policy/i);
  assert.ok(attributes(html, 'href').some((href) => href.endsWith('/SECURITY.md')));
});

test('public copy separates released npm from unreleased source and has no stale release narrative', () => {
  const version = JSON.parse(read('packages/release-harness/package.json')).version;
  for (const name of ['README.md', 'docs/index.html', 'docs/docs.html']) {
    const text = plain(read(name));
    assert.ok(text.includes(version), `${name}: package version context`);
    assert.match(text, /unreleased/i, name);
    assert.match(text, /npm/i, name);
  }
  const html = read('docs/docs.html');
  const skillRow = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find((match) => plain(match[1]).includes('skills list'));
  assert.ok(skillRow);
  assert.match(plain(skillRow[1]), /unreleased/i);
  const roadmap = /<section id="roadmap-levels">([\s\S]*?)<\/section>/.exec(html)?.[1];
  assert.ok(roadmap);
  assert.match(plain(roadmap), /Planned, not enabled/);
  assert.match(plain(roadmap), /run-ephemeral/);
  assert.match(plain(roadmap), /verify-canary/);
  assert.doesNotMatch(plain(roadmap), /\bv?\d+\.\d+\.\d+\b/);
  for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', ...files.map((file) => `docs/${file}`)]) {
    assert.doesNotMatch(read(name), /release-plan\.md|docs\/superpowers|\.superpowers\/|headPR\d+|PR\s*#?\d+\s+(?:coordination|handoff)/i, name);
  }
  assert.equal(fs.existsSync(path.join(docs, 'release-plan.md')), false);
  assert.doesNotMatch(read('docs/app.js'), /terminalOutputs|17 skills|Release-Harness v1\.0\.1|run-2026-prod-01/);
});
