import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_SITE_FILES = Object.freeze(['index.html', 'docs.html', 'style.css', 'app.js']);

export function buildPublicSite({ sourceDir = path.join(repoDir, 'docs'), outputDir = path.join(repoDir, '_site') } = {}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const relative = path.relative(output, source);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Site output must not contain the source directory');
  }
  // Check ancestors with lstat: existsSync follows links and misses dangling ones.
  for (const [label, target] of [['source', source], ['output', output]]) {
    for (let current = target; ; current = path.dirname(current)) {
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) throw new Error(`Site ${label} must not traverse links`);
      if (stat && !stat.isDirectory()) throw new Error(`Site ${label} must be a directory`);
      if (path.dirname(current) === current) break;
    }
  }
  const contents = PUBLIC_SITE_FILES.map((name) => {
    const file = path.join(source, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Public site input must be a regular file: ${name}`);
    return [name, fs.readFileSync(file)];
  });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const [name, content] of contents) fs.writeFileSync(path.join(output, name), content);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Built public site: ${buildPublicSite()}`);
}
