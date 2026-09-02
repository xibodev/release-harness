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

/**
 * Path segments whose contents belong to dependencies or tooling rather than to
 * the adopter's own source. The exclusion-warning scan skips anything beneath
 * them: a dependency that ships a test certificate is not something the adopter
 * can "commit", so warning about it is noise that buries the real signal.
 */
export const WARNING_SCAN_SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  '.pnpm-store',
  '.yarn',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.tox',
  '.gradle',
  '.m2',
  'target',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.brains',
  '.quality-run',
]);

const IS_WINDOWS = process.platform === 'win32';

/**
 * Reduce a path to a comparable canonical form. Beyond `path.resolve`, this
 * resolves symlinks and short names (macOS reports /var, git reports
 * /private/var; Windows may report 8.3 names) and folds case on Windows, where
 * `git rev-parse --show-toplevel` uppercases the drive letter regardless of the
 * case the caller used. Without this, a genuine git repository silently reverts
 * to the basename denylist.
 */
function canonicalizePath(p) {
  let out = path.resolve(p);
  try {
    out = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(out) : fs.realpathSync(out);
  } catch {
    // Unresolvable (missing/permission) — fall back to the resolved form.
  }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WINDOWS ? out.toLowerCase() : out;
}

function samePath(a, b) {
  return canonicalizePath(a) === canonicalizePath(b);
}

/**
 * True when git could not be executed or was cut short, as opposed to git
 * running fine and reporting "this is not a repository". The two must not share
 * a diagnosis: one is an ordinary non-git tree, the other is a real repository
 * whose enumeration failed.
 */
function isGitExecutionFailure(err) {
  if (!err) return false;
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') return true;
  if (err.code === 'ENOBUFS') return true;
  if (err.killed === true || err.signal) return true;
  return false;
}

function gitFailureReason(err) {
  if (!err) return 'unknown error';
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'the git executable could not be run';
  if (err.code === 'EACCES') return 'the git executable could not be run (permission denied)';
  if (err.code === 'ENOBUFS') return 'git produced more output than the read buffer allows';
  if (err.killed === true || err.signal) return `the git command was terminated (${err.signal || 'timeout'})`;
  if (typeof err.status === 'number') return `git exited with status ${err.status}`;
  return err.message || 'unknown error';
}

const DENYLIST_FALLBACK_CONSEQUENCE =
  'falling back to the conservative basename denylist, which excludes directories such as coverage/ and .cache/ by name. ' +
  'Any product source under those names will be absent from both the workspace copy and the tree digest.';

function gitOutputToPaths(stdout) {
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

function gitEnumerate(absPath) {
  const stdout = execSync('git ls-files -z --cached --others --exclude-standard', {
    cwd: absPath,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return gitOutputToPaths(stdout);
}

/**
 * True when `abs` resolves to a location inside `canonicalRoot` (or to the root
 * itself). Both sides go through `canonicalizePath`, so symlinks, 8.3 short
 * names and Windows drive-letter case are resolved before comparison: a textual
 * prefix test on unresolved paths is not a containment proof.
 */
function resolvesInsideRoot(abs, canonicalRoot) {
  const target = canonicalizePath(abs);
  return target === canonicalRoot || target.startsWith(`${canonicalRoot}/`);
}

/**
 * Classify one candidate path by what is actually on disk. Symlinks are
 * resolved so that both enumeration strategies agree on what a "file" is: a
 * symlink to a regular file counts as a file, a symlink to a directory or a
 * dangling symlink does not.
 *
 * A symlink to a regular file is additionally required to resolve INSIDE the
 * enumerated root. The boundary argument that keeps linked directories
 * untraversed (see `refineEntries`) applies unchanged to a single linked file:
 * following it would widen the declared source boundary, copying bytes the
 * adopter never placed in the tree and hashing content that exists only in this
 * checkout. A link whose target IS inside the tree stays enumerated — its bytes
 * are within the declared boundary, and both strategies list it alike.
 */
function classifyEntry(abs, canonicalRoot) {
  let linkStat;
  try {
    linkStat = fs.lstatSync(abs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 'missing';
    return 'unreadable';
  }

  if (linkStat.isSymbolicLink()) {
    let targetStat;
    try {
      targetStat = fs.statSync(abs);
    } catch {
      return 'dangling';
    }
    if (targetStat.isFile()) return resolvesInsideRoot(abs, canonicalRoot) ? 'file' : 'externalLink';
    if (targetStat.isDirectory()) return 'linkedDirectory';
    return 'special';
  }

  if (linkStat.isFile()) return 'file';
  if (linkStat.isDirectory()) return 'directory';
  return 'special';
}

function summarizePaths(list, limit = 5) {
  const shown = list.slice(0, limit).map((p) => `"${p}"`).join(', ');
  return list.length > limit ? `${shown} and ${list.length - limit} more` : shown;
}

/**
 * Resolve, for any relative directory path, the shallowest ancestor-or-self that
 * is a symlink — or null when the whole chain is made of real directories.
 *
 * The two strategies disagree about symlinked directories unless ancestry is
 * considered: `fsEnumerate` never descends one (a Dirent reflects lstat, so a
 * link is not `isDirectory()`), but `git ls-files` walks straight through it and
 * emits paths beneath it. `classifyEntry` cannot see the difference, because a
 * path under a linked directory lstats as a perfectly ordinary regular file.
 *
 * Memoized per directory prefix and short-circuited below a known link, so an
 * ancestor check costs at most one lstat per DISTINCT directory in the tree —
 * not one per component per file.
 */
function makeSymlinkAncestorResolver(absPath) {
  const cache = new Map([['', null]]);
  const resolve = (relDir) => {
    const cached = cache.get(relDir);
    if (cached !== undefined) return cached;
    const slash = relDir.lastIndexOf('/');
    const parent = slash === -1 ? '' : relDir.slice(0, slash);
    const inherited = resolve(parent);
    let result;
    if (inherited !== null) {
      // An ancestor already links away; this level needs no stat of its own.
      result = inherited;
    } else {
      let isLink = false;
      try {
        isLink = fs.lstatSync(path.join(absPath, relDir)).isSymbolicLink();
      } catch {
        isLink = false;
      }
      result = isLink ? relDir : null;
    }
    cache.set(relDir, result);
    return result;
  };
  return (rel) => {
    const slash = rel.replace(/\/+$/, '').lastIndexOf('/');
    if (slash === -1) return null;
    return resolve(rel.slice(0, slash));
  };
}

/**
 * Index modes keyed by path, used only to explain why an indexed path is absent
 * from disk. Mode 120000 is a symlink blob: with `core.symlinks=false` (the
 * Windows default without Developer Mode) the checkout may never materialize it,
 * which is a checkout-configuration gap and NOT an unstaged deletion. Returns an
 * empty map on any failure — the caller then softens its wording instead of
 * asserting a cause it has not established.
 */
function readIndexModes(absPath) {
  const modes = new Map();
  try {
    const stdout = execSync('git ls-files -s -z', {
      cwd: absPath,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const row of stdout.toString('utf8').split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab === -1) continue;
      const mode = row.slice(0, row.indexOf(' '));
      modes.set(row.slice(tab + 1).replace(/\\/g, '/'), mode);
    }
  } catch {
    return new Map();
  }
  return modes;
}

/**
 * Turn a raw candidate list into the enumeration contract: relative POSIX paths
 * naming regular files that exist on disk, deduplicated and sorted.
 *
 * Every drop here is a case the raw candidate list gets wrong and a downstream
 * consumer would crash on. `git ls-files --cached` reports the index, so it
 * lists a nested repository or submodule as a bare directory (EISDIR on read),
 * a file deleted without staging the deletion (ENOENT on read), and one row per
 * index stage for a file in an unresolved merge conflict (the same content
 * hashed three times, yielding a digest that no longer matches the identical
 * tree once the conflict is resolved).
 *
 * It also enforces the equivalence the module exists for: a path is dropped when
 * any ANCESTOR directory component is a symlink. `git ls-files` walks through a
 * symlinked directory and emits paths beneath it; the filesystem walk never
 * descends one. Without this check the same tree enumerates differently by
 * strategy, and a digest that changes with strategy is not a provenance record.
 * Not-traversing is the side both strategies are aligned to: the linked target
 * is either already inside the tree — in which case its bytes are enumerated
 * under their real path and a second path double-counts them — or outside it, in
 * which case following the link would silently widen the declared source
 * boundary and copy files the adopter never placed in the tree.
 */
function refineEntries(absPath, candidates, warnings, indexModes = new Map()) {
  const seen = new Set();
  const files = [];
  const symlinkAncestorOf = makeSymlinkAncestorResolver(absPath);
  const canonicalRoot = canonicalizePath(absPath);
  const dropped = {
    directory: [],
    missing: [],
    missingSymlinkBlob: [],
    dangling: [],
    linkedDirectory: [],
    externalLink: [],
    underLinkedDirectory: [],
    unreadable: [],
    special: [],
  };
  const linkedAncestors = new Set();

  for (const raw of candidates) {
    if (!raw) continue;
    // `git ls-files` reports an untracked nested repository with a trailing
    // slash ("vendor-app/"). Normalize so dedupe is meaningful and so a path
    // cannot be reported in two spellings.
    const rel = raw.replace(/\/+$/, '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);

    const linkedAncestor = symlinkAncestorOf(rel);
    if (linkedAncestor !== null) {
      linkedAncestors.add(linkedAncestor);
      dropped.underLinkedDirectory.push(rel);
      continue;
    }

    const kind = classifyEntry(path.join(absPath, rel), canonicalRoot);
    if (kind === 'file') files.push(rel);
    else if (kind === 'missing' && indexModes.get(rel) === '120000') dropped.missingSymlinkBlob.push(rel);
    else dropped[kind].push(rel);
  }

  if (dropped.directory.length > 0) {
    warnings.push(
      `Excluded ${dropped.directory.length} enumerated path(s) that are directories rather than regular files: ${summarizePaths(dropped.directory)}. ` +
        'A nested git repository or submodule is reported by git as a single directory entry; its contents are not part of this source tree.'
    );
  }
  if (dropped.missing.length > 0) {
    warnings.push(
      `Excluded ${dropped.missing.length} path(s) present in the git index but absent from the working tree: ${summarizePaths(dropped.missing)}. ` +
        'The workspace mirrors the working tree, so they will not be present. The usual cause is a deletion that was not staged, ' +
        'but a checkout that did not materialize the path produces the same result.'
    );
  }
  if (dropped.missingSymlinkBlob.length > 0) {
    warnings.push(
      `Excluded ${dropped.missingSymlinkBlob.length} symlink(s) recorded in the git index (mode 120000) but absent from the working tree: ${summarizePaths(dropped.missingSymlinkBlob)}. ` +
        'This is a checkout configuration gap rather than a deletion: with core.symlinks=false — the Windows default outside Developer Mode — ' +
        'git does not materialize symlink blobs. Enable Developer Mode or set core.symlinks=true and re-checkout if the build needs these paths.'
    );
  }
  if (dropped.dangling.length > 0) {
    warnings.push(
      `Excluded ${dropped.dangling.length} dangling symlink(s) whose target does not exist: ${summarizePaths(dropped.dangling)}.`
    );
  }
  if (dropped.linkedDirectory.length > 0) {
    warnings.push(
      `Excluded ${dropped.linkedDirectory.length} symlink(s) that resolve to a directory rather than a file: ${summarizePaths(dropped.linkedDirectory)}.`
    );
  }
  if (dropped.externalLink.length > 0) {
    warnings.push(
      `Excluded ${dropped.externalLink.length} symlink(s) whose target resolves outside the source tree: ${summarizePaths(dropped.externalLink)}. ` +
        'Following them would widen the declared source boundary, copying bytes the adopter never placed in the tree and hashing content ' +
        'that exists only in this checkout. Copy the target into the tree if the build needs it.'
    );
  }
  if (dropped.underLinkedDirectory.length > 0) {
    warnings.push(
      `Excluded ${dropped.underLinkedDirectory.length} path(s) reached only through a symlinked directory (${summarizePaths([...linkedAncestors])}): ${summarizePaths(dropped.underLinkedDirectory)}. ` +
        'Symlinked directories are not traversed by either enumeration strategy: their contents are either already enumerated under their real path, ' +
        'or they lie outside the declared source tree. Copy or move the contents into the tree if the build needs them.'
    );
  }
  if (dropped.unreadable.length > 0) {
    warnings.push(
      `Excluded ${dropped.unreadable.length} path(s) that could not be inspected: ${summarizePaths(dropped.unreadable)}.`
    );
  }
  if (dropped.special.length > 0) {
    warnings.push(
      `Excluded ${dropped.special.length} path(s) that are neither regular files nor directories (socket, FIFO or device): ${summarizePaths(dropped.special)}.`
    );
  }

  files.sort();
  return files;
}

/**
 * Conservative filesystem walk for non-git and nested sub-repo trees.
 * A directory that cannot be read is skipped with a warning rather than
 * aborting the whole enumeration: one unreadable subdirectory must not fail a
 * release run.
 */
function fsEnumerate(absPath, warnings) {
  const out = [];
  const walk = (dir, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(
        `Skipped unreadable directory "${relBase || '.'}" during filesystem enumeration (${err && err.code ? err.code : err.message}).`
      );
      return;
    }
    for (const entry of entries) {
      if (FALLBACK_IGNORED_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      // Dirent reflects lstat, so a symlink to a directory is not isDirectory()
      // and is never descended into — it is classified in refineEntries instead.
      // The git path reaches the same outcome through the ancestor check there.
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(absPath, '');
  return out;
}

/**
 * Scan for git-ignored files present on disk that a build plausibly needs, so
 * their exclusion can be reported rather than silently inferred. Dependency and
 * tooling directories are skipped: their contents are not the adopter's to
 * commit, and in a typical repo they are the overwhelming majority of ignored
 * paths.
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
    ignored = gitOutputToPaths(stdout);
  } catch {
    return warnings;
  }
  for (const rel of ignored) {
    const dirSegments = rel.split('/').slice(0, -1);
    if (dirSegments.some((segment) => WARNING_SCAN_SKIPPED_DIRS.has(segment))) continue;
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
 *
 * Returns `{ files, strategy, warnings }` where `files` is a sorted,
 * deduplicated list of relative POSIX paths, each naming a regular file that
 * exists on disk. It never throws: every failure mode degrades to a narrower
 * list plus a warning that names the cause.
 */
export function enumerateSource(sourcePath) {
  const absPath = path.resolve(sourcePath);
  const warnings = [];

  let rootStat;
  try {
    rootStat = fs.statSync(absPath);
  } catch (err) {
    const reason = err && err.code === 'EACCES' ? 'is not readable' : 'does not exist';
    return { files: [], strategy: 'filesystem', warnings: [`Source path ${reason}: ${absPath}`] };
  }
  if (!rootStat.isDirectory()) {
    return {
      files: [],
      strategy: 'filesystem',
      warnings: [`Source path is not a directory, so it cannot be enumerated as a source tree: ${absPath}`],
    };
  }

  let files = null;
  let strategy = 'filesystem';
  let indexModes = new Map();

  let topLevel = null;
  let probeError = null;
  try {
    topLevel = execSync('git rev-parse --show-toplevel', {
      cwd: absPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch (err) {
    probeError = err;
  }

  if (probeError) {
    if (isGitExecutionFailure(probeError)) {
      warnings.push(
        `Git could not determine whether the source is a repository (${gitFailureReason(probeError)}); ${DENYLIST_FALLBACK_CONSEQUENCE}`
      );
    } else {
      warnings.push(
        'Source is not an independent git repository; using filesystem enumeration with a conservative exclusion list.'
      );
    }
  } else if (!topLevel) {
    warnings.push(
      'Source is not an independent git repository; using filesystem enumeration with a conservative exclusion list.'
    );
  } else if (samePath(topLevel, absPath)) {
    try {
      files = gitEnumerate(absPath);
      strategy = 'git';
      indexModes = readIndexModes(absPath);
    } catch (err) {
      files = null;
      warnings.push(
        `Source IS a git repository, but git enumeration failed (${gitFailureReason(err)}); ${DENYLIST_FALLBACK_CONSEQUENCE}`
      );
    }
    if (files !== null) warnings.push(...collectExclusionWarnings(absPath));
  } else {
    warnings.push(
      `Source is nested inside git repository at ${topLevel}; using filesystem enumeration with a conservative exclusion list.`
    );
  }

  if (files === null) files = fsEnumerate(absPath, warnings);

  return { files: refineEntries(absPath, files, warnings, indexModes), strategy, warnings };
}
