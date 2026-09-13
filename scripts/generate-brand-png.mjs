import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoDir, 'brand', 'og', 'og-default.svg');
const canonicalPath = path.join(repoDir, 'brand', 'og', 'og-default.png');
const projectionPath = path.join(repoDir, 'docs', 'og-default.png');
const width = 1200;
const height = 630;

function pngDimensions(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'renderer must emit PNG');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG must begin with IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function renderSocialPng() {
  const svg = fs.readFileSync(sourcePath, 'utf8');
  assert.match(svg, /<svg\b[^>]*\bwidth="1200"[^>]*\bheight="630"[^>]*\bviewBox="0 0 1200 630"/, 'canonical SVG dimensions');

  // Exact bytes assume the same Playwright Chromium build and host font set.
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-lcd-text', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    await page.setContent(`<style>html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden}svg{display:block}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.locator('svg').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    assert.deepEqual(dimensions, { width, height }, 'canonical SVG must render at its declared size');
    const png = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
      scale: 'css',
    });
    assert.deepEqual(pngDimensions(png), { width, height });
    return png;
  } finally {
    await browser.close();
  }
}

export async function generateSocialPng({ check = false } = {}) {
  const generated = await renderSocialPng();
  if (check) {
    for (const target of [canonicalPath, projectionPath]) {
      assert.ok(fs.existsSync(target), `missing generated PNG: ${path.relative(repoDir, target)}`);
      assert.deepEqual(fs.readFileSync(target), generated, `stale generated PNG: ${path.relative(repoDir, target)}`);
    }
    return;
  }
  fs.writeFileSync(canonicalPath, generated);
  fs.writeFileSync(projectionPath, generated);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every((arg) => arg === '--check'), `unknown option: ${args.find((arg) => arg !== '--check')}`);
  const check = args.includes('--check');
  await generateSocialPng({ check });
  console.log(check ? 'Brand PNG is current.' : 'Generated brand/og/og-default.png and docs/og-default.png.');
}
