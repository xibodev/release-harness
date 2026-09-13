import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_SITE_FILES = Object.freeze([
  'index.html',
  'docs.html',
  'style.css',
  'app.js',
  'favicon.svg',
  'logo-mark.svg',
  'og-default.png',
]);

/**
 * Build only the public site allowlist.
 *
 * The repository has carried private plans, validation transcripts and working
 * notes under documentation-shaped paths before. Publication is therefore an
 * explicit allowlisted projection, never a recursive copy of docs/.
 */
export function buildPublicSite({
  sourceDir = path.join(repo, 'docs'),
  outputDir = path.join(repo, '_site'),
} = {}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const relative = path.relative(output, source);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Site output must not contain the source directory');
  }

  const files = PUBLIC_SITE_FILES.map((name) => {
    const input = path.join(source, name);
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Public site input must be a regular file: ${name}`);
    }
    return [name, fs.readFileSync(input)];
  });

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const [name, bytes] of files) fs.writeFileSync(path.join(output, name), bytes);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Built public site: ${buildPublicSite()}`);
}
