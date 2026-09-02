import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Basenames excluded ONLY on the filesystem fallback path, where git cannot
 * enumerate (non-git trees, vendored local_path repos, nested sub-repos).
 * Deliberately excludes product-source-plausible names such as docs, uploads,
 * research, and brand: on the git path nothing is basename-matched at all.
 */
export const FALLBACK_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.cache',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
  '.brains',
  '.quality-run',
]);

/**
 * Git-ignored files a build plausibly needs. Excluding these is correct — the
 * workspace must mirror committed source — but silence would leave the adopter
 * inferring the cause from a downstream compose error, so we name them.
 */
export const LIKELY_NEEDED_IGNORED = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.npmrc$/,
  /\.pem$/,
  /\.key$/,
];

function gitEnumerate(absPath) {
  const stdout = execSync('git ls-files -z --cached --others --exclude-standard', {
    cwd: absPath,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

function fsEnumerate(absPath) {
  const out = [];
  const walk = (dir, relBase) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (FALLBACK_IGNORED_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push(rel);
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(absPath, '');
  return out;
}

/**
 * Scan for git-ignored files present on disk that a build plausibly needs, so
 * their exclusion can be reported rather than silently inferred.
 */
function collectExclusionWarnings(absPath) {
  const warnings = [];
  let ignored = [];
  try {
    const stdout = execSync('git ls-files -z --others --ignored --exclude-standard', {
      cwd: absPath,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    ignored = stdout.toString('utf8').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  } catch {
    return warnings;
  }
  for (const rel of ignored) {
    if (LIKELY_NEEDED_IGNORED.some((re) => re.test(rel))) {
      warnings.push(
        `Excluded git-ignored file "${rel}" — it is not in the repository, so the workspace build cannot use it. Commit it or supply the value through .release-harness/harness.config.json.`
      );
    }
  }
  return warnings;
}

/**
 * Single enumeration feeding BOTH the workspace copy and the tree digest.
 * One list means copy set and digest set cannot diverge.
 */
export function enumerateSource(sourcePath) {
  const absPath = path.resolve(sourcePath);
  if (!fs.existsSync(absPath)) {
    return { files: [], strategy: 'filesystem', warnings: [`Source path does not exist: ${absPath}`] };
  }

  let files = null;
  let strategy = 'filesystem';
  const warnings = [];

  try {
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd: absPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();

    if (path.resolve(topLevel) === absPath) {
      files = gitEnumerate(absPath);
      strategy = 'git';
      warnings.push(...collectExclusionWarnings(absPath));
    } else {
      warnings.push(
        `Source is nested inside git repository at ${topLevel}; using filesystem enumeration with a conservative exclusion list.`
      );
    }
  } catch {
    warnings.push('Source is not an independent git repository; using filesystem enumeration with a conservative exclusion list.');
  }

  if (files === null) files = fsEnumerate(absPath);

  files.sort();
  return { files, strategy, warnings };
}
