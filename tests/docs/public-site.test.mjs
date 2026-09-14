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
const publicFiles = ['app.js', 'docs.html', 'favicon.svg', 'index.html', 'logo-mark.svg', 'og-default.png', 'style.css'];
const brandAssets = [
  'icons/app-icon.svg',
  'icons/favicon.svg',
  'icons/icon-192.svg',
  'icons/icon-512.svg',
  'logos/lockup-inverse.svg',
  'logos/lockup.svg',
  'logos/mark-inverse.svg',
  'logos/mark.svg',
  'logos/mono-black.svg',
  'logos/mono-white.svg',
  'logos/wordmark-inverse.svg',
  'logos/wordmark.svg',
  'og/og-default.png',
  'og/og-default.svg',
];
const markBearingSvgs = [
  'brand/icons/app-icon.svg',
  'brand/icons/favicon.svg',
  'brand/icons/icon-192.svg',
  'brand/icons/icon-512.svg',
  'brand/logos/lockup-inverse.svg',
  'brand/logos/lockup.svg',
  'brand/logos/mark-inverse.svg',
  'brand/logos/mark.svg',
  'brand/logos/mono-black.svg',
  'brand/logos/mono-white.svg',
  'brand/og/og-default.svg',
  'docs/favicon.svg',
  'docs/logo-mark.svg',
];
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');
const readBuffer = (relative) => fs.readFileSync(path.join(repo, relative));

function pngDimensions(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG signature');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

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

test('public artifact is exactly the seven byte-identical allowlisted files', (t) => {
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

test('landing install commands stay contained by their local scroller', () => {
  const css = read('docs/style.css');
  assert.match(css, /\.install-panel\s*\{[^}]*\bmin-width:\s*0\s*;/);
  assert.match(css, /pre\s*\{[^}]*\boverflow-x:\s*auto\s*;/);
});

test('site headers use the approved identity, canonical URLs and PNG social metadata', () => {
  const imageUrl = 'https://xibodev.github.io/release-harness/og-default.png';
  const pages = [
    [
      'docs/index.html',
      'https://xibodev.github.io/release-harness/',
      'Release-Harness — Accepted propositions, deterministic evidence',
      'Certify deliberately accepted HTTP and CLI release propositions with deterministic, sealed evidence.',
    ],
    [
      'docs/docs.html',
      'https://xibodev.github.io/release-harness/docs.html',
      'Release-Harness Documentation',
      'Beta documentation for accepted release propositions, deterministic execution, evidence sealing, and verification.',
    ],
  ];
  for (const [name, canonicalUrl, title, description] of pages) {
    const html = read(name);
    for (const tag of [
      `<link rel="canonical" href="${canonicalUrl}">`,
      '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Release-Harness">',
      `<meta property="og:url" content="${canonicalUrl}">`,
      `<meta property="og:title" content="${title}">`,
      `<meta property="og:description" content="${description}">`,
      `<meta property="og:image" content="${imageUrl}">`,
      '<meta property="og:image:type" content="image/png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="Release-Harness: A release cannot be talked into green.">',
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${title}">`,
      `<meta name="twitter:description" content="${description}">`,
      `<meta name="twitter:image" content="${imageUrl}">`,
      '<meta name="twitter:image:alt" content="Release-Harness: A release cannot be talked into green.">',
    ]) assert.ok(html.includes(tag), `${name}: missing ${tag}`);
    assert.match(html, /<a href="index\.html" class="brand" aria-label="Release-Harness home">/);
    assert.match(html, /<img src="logo-mark\.svg" width="38" height="38" alt="">/);
    assert.match(html, /<span class="brand-name" aria-hidden="true">release\.harness<\/span>/);
    assert.doesNotMatch(html, /class="brand-badge"|>RH<\/span>/);
    assert.doesNotMatch(html, /(?:og|twitter):image[^>]+\.svg/i);
  }
});

test('brand provenance inventories the complete kit and runtime projections', () => {
  const provenance = JSON.parse(read('brand/provenance.json'));
  assert.equal(provenance.product.formal_name, 'Release-Harness');
  assert.equal(provenance.product.visual_wordmark, 'release.harness');
  assert.equal(provenance.external_assets.length, 0);
  assert.doesNotMatch(JSON.stringify(provenance), /\b(?:sha|hash|digest|checksum)\b/i);
  assert.deepEqual(Object.values(provenance.assets).flat().sort(), brandAssets);
  const onDisk = ['icons', 'logos', 'og'].flatMap((directory) =>
    fs.readdirSync(path.join(repo, 'brand', directory)).map((name) => `${directory}/${name}`)
  ).sort();
  assert.deepEqual(onDisk, brandAssets);
  assert.deepEqual(provenance.runtime_projections, {
    'docs/favicon.svg': 'icons/favicon.svg',
    'docs/logo-mark.svg': 'logos/mark.svg',
    'docs/og-default.png': 'og/og-default.png',
  });
  for (const [projection, source] of Object.entries(provenance.runtime_projections)) {
    assert.deepEqual(readBuffer(projection), readBuffer(`brand/${source}`), projection);
  }
  assert.deepEqual(pngDimensions(readBuffer('brand/og/og-default.png')), { width: 1200, height: 630 });
  assert.equal(fs.existsSync(path.join(docs, 'og-default.svg')), false, 'canonical social SVG stays outside the site projection');
});

test('mark-bearing variants retain the exact approved geometry', () => {
  const { mark } = JSON.parse(read('brand/provenance.json'));
  assert.equal(mark.viewBox, '0 0 100 100');
  const { geometry } = mark;
  for (const name of markBearingSvgs) {
    const svg = read(name);
    for (const expected of [geometry.left_jaw, geometry.right_jaw, geometry.check.path]) {
      assert.ok(svg.includes(expected), `${name}: canonical path ${expected}`);
    }
    assert.match(svg, new RegExp(`<circle\\s+cx="${geometry.center.cx}"\\s+cy="${geometry.center.cy}"\\s+r="${geometry.center.r}"`), `${name}: canonical center`);
    assert.match(svg, new RegExp(`stroke-width="${geometry.check.stroke_width}"[^>]*stroke-linecap="${geometry.check.linecap}"[^>]*stroke-linejoin="${geometry.check.linejoin}"`), `${name}: canonical check stroke`);
  }
  const markSvg = read('brand/logos/mark.svg');
  assert.match(markSvg, /viewBox="0 0 100 100"/);
  assert.match(markSvg, /<rect width="100" height="100" fill="#14171E"/);
  for (const color of ['#94A3B8', '#EAB308', '#14171E']) assert.ok(markSvg.includes(color), `primary mark uses ${color}`);
  assert.match(read('brand/BRAND.md'), /canonical mark uses the `0 0 100 100` coordinate system[\s\S]*wider viewBoxes/);
});

test('brand tokens, accessible names and preview labels stay consistent', () => {
  const provenance = JSON.parse(read('brand/provenance.json'));
  const tokens = JSON.parse(read('brand/tokens.json'));
  assert.deepEqual(provenance.palette, tokens.color);
  const css = new Map([...read('brand/tokens.css').matchAll(/--rh-([\w-]+):\s*(#[\dA-F]{6});/g)].map((match) => [match[1], match[2]]));
  for (const [name, value] of Object.entries(tokens.color)) {
    assert.equal(css.get(name.replaceAll('_', '-')), value, `CSS token ${name}`);
  }
  for (const name of [...brandAssets.filter((asset) => asset.endsWith('.svg')).map((asset) => `brand/${asset}`), 'docs/favicon.svg', 'docs/logo-mark.svg']) {
    const svg = read(name);
    const title = /<title\b[^>]*>([^<]+)<\/title>/.exec(svg)?.[1];
    assert.ok(title?.startsWith('Release-Harness'), `${name}: formal accessible title`);
    assert.doesNotMatch(title, /release\.harness/, `${name}: visual wordmark is not the accessible name`);
    assert.match(svg, /role="img"[^>]*aria-labelledby="title(?:\s+desc)?"/, `${name}: labelled image role`);
    assert.match(svg, /^<svg\b[\s\S]*<\/svg>\s*$/, `${name}: complete SVG document`);
  }
  for (const name of ['brand/logos/wordmark.svg', 'brand/logos/wordmark-inverse.svg']) {
    assert.match(read(name), />release\.harness<\/text>/, `${name}: visual wordmark`);
  }
  for (const label of [...read('brand/preview.html').matchAll(/<figcaption>([^<]+)<\/figcaption>/g)].map((match) => match[1])) {
    assert.match(label, /^Release-Harness\b/, `formal preview label: ${label}`);
  }
});

test('brand copy assigns decisions to declared policy and evidence without retired architecture', () => {
  const files = [
    'brand/BRAND.md',
    'brand/README.md',
    'brand/preview.html',
    'brand/og/og-default.svg',
    'docs/index.html',
    'docs/docs.html',
  ];
  const forbiddenArchitecture = /\b(?:2\.0\.0|run-local|check-pr|release-conductor|scenario-compiler|fix-planner|fix-executor)\b|topology\.json|origins\.json/;
  for (const name of files) {
    const text = read(name);
    assert.doesNotMatch(text, forbiddenArchitecture, `${name}: retired architecture`);
    assert.doesNotMatch(text, /\b(?:only\s+)?evidence\s+(?:alone\s+)?(?:can\s+)?decid(?:e|es)\b/i, `${name}: evidence alone cannot decide`);
  }
  assert.match(read('docs/index.html'), /the deterministic evaluator decides from declared policy and recorded evidence/i);
});

test('repository Markdown links resolve locally', () => {
  for (const name of [
    'README.md',
    'BETA-RELEASE-NOTES.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'brand/README.md',
    'brand/BRAND.md',
    'brand/LICENSES.md',
  ]) {
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
