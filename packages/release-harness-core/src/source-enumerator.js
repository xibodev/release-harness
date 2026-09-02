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

const EMPTY_DIR_DENYLIST_FALLBACK_CONSEQUENCE =
  'falling back to the conservative basename denylist, which knows nothing of the ignore rules in this repository. ' +
  'Directories the repository ignores — dist/, build/, target/ and the like — may be recreated in the workspace as empty skeletons.';

function gitOutputToPaths(stdout) {
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

function gitEnumerate(absPath, includeUntracked) {
  // `--others` admits untracked-but-not-ignored paths. That is required for an
  // --allow-dirty run (the workspace must mirror what is actually on disk) and
  // wrong for a certification run, where leftover test output such as
  // test-results/ or playwright-report/ would otherwise enter both the copy and
  // the tree digest, making provenance a function of the last test run.
  const command = includeUntracked
    ? 'git ls-files -z --cached --others --exclude-standard'
    : 'git ls-files -z --cached';
  const stdout = execSync(command, {
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
 * The set of paths git considers ignored in this tree, resolved in TWO
 * subprocesses total regardless of tree size.
 *
 * Returns `null` — meaning "no git opinion is available" — for a non-git tree,
 * a nested sub-repo, or any git failure. A null result is what sends the caller
 * back to the basename denylist; an EMPTY result means git ran and found nothing
 * ignored, which is a different and equally load-bearing answer.
 *
 * Two spawns rather than one because `git ls-files --others --ignored
 * --directory` collapses its answer: it reports `logs/` for a directory that is
 * NOT itself ignored but whose every entry is (`logs/run.log`), using the same
 * trailing-slash spelling it uses for a genuinely ignored `dist/`. Treating that
 * listing alone as "these directories are ignored" would delete exactly the
 * NEW-2 case from the workspace. `git check-ignore` is therefore asked to
 * confirm which of those directory entries are ignored *in their own right*; it
 * takes the whole batch on stdin, so the cost is one spawn, not one per
 * directory.
 *
 * `check-ignore` exits 1 with empty stdout when NOTHING in the batch is ignored.
 * That is a successful answer, not a failure, and is reported as such.
 *
 * When a null result IS a failure rather than an absence of git authority, the
 * causing error is recorded on `failure.error` so the caller can name the cause
 * instead of degrading silently.
 */
function resolveGitIgnoreSets(absPath, failure = {}) {
  let listed;
  try {
    listed = gitOutputToPaths(
      execSync('git ls-files -z --others --ignored --directory --exclude-standard', {
        cwd: absPath,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      })
    );
  } catch (err) {
    failure.error = err;
    return null;
  }

  // `gitOutputToPaths` strips nothing, so a directory entry is still spelled
  // with its trailing slash here and is distinguishable from a file entry.
  const ignoredFiles = new Set();
  const candidateDirs = [];
  for (const entry of listed) {
    if (entry.endsWith('/')) candidateDirs.push(entry.replace(/\/+$/, ''));
    else ignoredFiles.add(entry);
  }

  const ignoredDirs = new Set();
  if (candidateDirs.length > 0) {
    let stdout = null;
    try {
      stdout = execSync('git check-ignore -z --stdin', {
        cwd: absPath,
        input: Buffer.from(`${candidateDirs.join('\0')}\0`, 'utf8'),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // Exit 1 = "none of the batch is ignored", which arrives as a thrown
      // error with empty stdout. Anything that produced no stdout at all and
      // did not exit 1 is a real failure: fall back rather than assert.
      //
      // `!= null` rather than `!== undefined`: a null stdout satisfies the
      // looser check and reaches `gitOutputToPaths(null)`, which throws
      // TypeError out of a function this module documents as never throwing.
      // That is load-bearing - the whole warn-not-fail policy rests on this
      // returning null instead of propagating an exception to the caller.
      if (err && err.status === 1 && err.stdout != null) {
        stdout = err.stdout;
      } else {
        failure.error = err;
        return null;
      }
    }
    for (const p of gitOutputToPaths(stdout)) ignoredDirs.add(p.replace(/\/+$/, ''));
  }

  return { ignoredDirs, ignoredFiles };
}

/**
 * The set of paths git considers UNTRACKED-but-not-ignored, in one subprocess.
 *
 * Needed only when `includeUntracked` is false. In that mode no untracked file
 * is copied, so a directory holding nothing else contributes nothing to the
 * workspace - and must be reported as excluded rather than silently absent.
 *
 * Returns `null` on any git failure so the caller can name the degradation
 * rather than silently treating every path as tracked.
 *
 * WITHOUT `--directory`, git lists untracked paths individually; the only
 * directory-shaped row it emits is an untracked NESTED REPOSITORY, which it
 * cannot descend. Such a row therefore means "this entire subtree is untracked"
 * unambiguously - unlike the `--ignored --directory` listing, which collapses
 * two different conditions into one spelling and needs a second subprocess to
 * disambiguate.
 */
function resolveUntrackedSets(absPath, failure = {}) {
  let listed;
  try {
    listed = gitOutputToPaths(
      execSync('git ls-files -z --others --exclude-standard', {
        cwd: absPath,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      })
    );
  } catch (err) {
    failure.error = err;
    return null;
  }

  const untrackedFiles = new Set();
  const untrackedRoots = [];
  for (const entry of listed) {
    if (entry.endsWith('/')) untrackedRoots.push(entry.replace(/\/+$/, ''));
    else untrackedFiles.add(entry);
  }
  return { untrackedFiles, untrackedRoots };
}

/**
 * Directories that hold nothing the workspace will contain.
 *
 * Git has no concept of an empty directory, so a workspace built purely from an
 * enumerated file list silently loses `uploads/`, `tmp/cache/` and friends — a
 * product whose build or compose expects a runtime directory then fails in the
 * workspace but not locally. These carry no content, so they must never reach
 * the tree digest (git's own model does not track them); they exist only to make
 * the copy faithful.
 *
 * "Empty" is judged from the WORKSPACE's perspective, not the disk's. A
 * directory whose only contents are ignored — `logs/` holding just `run.log` —
 * contributes no enumerated file, so the workspace would otherwise lack it
 * entirely with nothing said. It is empty as far as the copy is concerned, and
 * is recreated as such.
 *
 * Exclusions mirror what `enumerateSource` already excludes, and by the same
 * authority: on a git tree the ignore rules come from git itself, so a repo
 * ignoring `dist/ target/ .tox/` gets no recreated build-tree skeletons — the
 * previous basename-only filter recreated every one of them, reintroducing the
 * build-state leakage the untracked-file exclusion exists to prevent. A non-git
 * tree has no such authority available and keeps the conservative basename
 * denylist. Symlinked directories are excluded on both paths: a Dirent reflects
 * lstat, so a symlink to a directory is not `isDirectory()` and is never
 * descended into, matching both enumeration strategies.
 *
 * Cost is bounded at three git subprocesses for the whole tree (two for the
 * ignore rules, one more only when untracked files are excluded), plus the same
 * single directory walk as before — never a subprocess per directory.
 *
 * `options.includeUntracked` must MATCH the value given to `enumerateSource`
 * for the same tree. When it is false, no untracked file is copied, so a
 * directory holding only untracked files contributes nothing to the workspace.
 * Such a directory is NOT recreated — git has no record of it, so a fresh clone
 * would not have it either, and building it would make the workspace structure
 * a function of the last local build. It is reported instead, so the exclusion
 * is visible rather than inferred from a downstream failure.
 *
 * Never throws: an unreadable directory is reported as a warning and skipped,
 * as is a git repository whose ignore rules could not be obtained — that fallback
 * is the difference between excluding build trees and recreating them.
 */
export function enumerateEmptyDirectories(sourcePath, warnings = [], options = {}) {
  const { includeUntracked = true } = options;
  const absPath = path.resolve(sourcePath);
  const empty = [];

  try {
    if (!fs.statSync(absPath).isDirectory()) return [];
  } catch {
    return [];
  }

  // Only a tree that IS its own repository may use git's ignore rules; a nested
  // sub-repo's ignores are the parent's business, exactly as in `enumerateSource`.
  let ignoreSets = null;
  let isOwnRepo = false;
  const ignoreFailure = {};
  try {
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd: absPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (topLevel && samePath(topLevel, absPath)) {
      isOwnRepo = true;
      ignoreSets = resolveGitIgnoreSets(absPath, ignoreFailure);
    }
  } catch {
    // Not a repository, or the probe itself failed. Either way this tree has no
    // git authority to consult here, and `enumerateSource` has already reported
    // the same condition against the same source path.
    ignoreSets = null;
  }

  // The tree IS a git repository, so `enumerateSource` enumerated it with git's
  // authority and reports strategy 'git' — but that authority could not be
  // obtained for this walk. Falling back to basenames here silently undoes the
  // exclusion the git path exists to provide, so it is named, exactly as every
  // other fallback in this file is.
  if (isOwnRepo && ignoreSets === null) {
    warnings.push(
      `Source IS a git repository, but its ignore rules could not be obtained for the empty-directory scan (${gitFailureReason(ignoreFailure.error)}); ${EMPTY_DIR_DENYLIST_FALLBACK_CONSEQUENCE}`
    );
  }

  // A certification run copies no untracked file, so a directory holding only
  // untracked files contributes nothing to the workspace. Only consulted when
  // git is the authority AND untracked files are excluded; on every other path
  // there is nothing to ask or nothing to answer.
  let untrackedSets = null;
  const untrackedFailure = {};
  if (isOwnRepo && ignoreSets !== null && !includeUntracked) {
    untrackedSets = resolveUntrackedSets(absPath, untrackedFailure);
    if (untrackedSets === null) {
      warnings.push(
        `Source IS a git repository, but its untracked-file list could not be obtained for the empty-directory scan (${gitFailureReason(untrackedFailure.error)}); ` +
          'a directory holding only untracked files is treated as holding content, so its exclusion from the workspace will not be reported.'
      );
    }
  }

  /**
   * True when this path must not appear in the workspace at all. On the git
   * path `.git` is excluded explicitly — git does not report its own directory
   * as ignored — and everything else is git's own answer.
   */
  const isExcludedDir = (rel, name) => {
    if (name === '.git') return true;
    if (ignoreSets === null) return FALLBACK_IGNORED_NAMES.has(name);
    return ignoreSets.ignoredDirs.has(rel);
  };

  const isExcludedFile = (rel, name) => {
    if (ignoreSets === null) return FALLBACK_IGNORED_NAMES.has(name) || name.endsWith('.pyc');
    return ignoreSets.ignoredFiles.has(rel);
  };

  /**
   * True when this file exists on disk but will not be copied because the run
   * excludes untracked files. An untracked NESTED REPOSITORY arrives from git as
   * a directory-shaped row covering its whole subtree, so containment is tested
   * as well as equality.
   */
  const isUntracked = (rel) => {
    if (untrackedSets === null) return false;
    if (untrackedSets.untrackedFiles.has(rel)) return true;
    return untrackedSets.untrackedRoots.some((root) => rel === root || rel.startsWith(`${root}/`));
  };

  // Directories holding nothing but untracked files. NOT recreated: git has no
  // record of them, so a fresh clone would not have them either, and
  // materializing them would reintroduce exactly the build-state leakage that
  // excluding untracked files exists to prevent. They must not vanish in
  // silence either, so they are reported below.
  const untrackedOnlyDirs = [];

  /**
   * Classifies `relBase` by what it contributes to the workspace:
   *   'content'       - at least one file will be copied from it or below it
   *   'untrackedOnly' - nothing will be copied, but files exist on disk that
   *                     this run excludes because they are untracked
   *   'empty'         - nothing will be copied and there is nothing to exclude
   *
   * A parent inherits the strongest classification of its children, so an
   * `onlyempty/nested-empty` chain is still recreated in full while a `var/run/`
   * holding one untracked file leaves both `var/` and `var/run/` unbuilt.
   */
  const walk = (dir, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(
        `Skipped unreadable directory "${relBase || '.'}" while scanning for empty directories (${err && err.code ? err.code : err.message}).`
      );
      // Unknown contents: do not claim it is empty.
      return 'content';
    }

    let contributesContent = false;
    let holdsUntracked = false;
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isExcludedDir(rel, entry.name)) continue;
        const kind = walk(path.join(dir, entry.name), rel);
        if (kind === 'content') contributesContent = true;
        else if (kind === 'untrackedOnly') holdsUntracked = true;
      } else {
        // A symlink is not isDirectory(); it is a workspace-visible entry
        // unless ignored, and it keeps its parent from counting as empty.
        if (isExcludedFile(rel, entry.name)) continue;
        if (isUntracked(rel)) holdsUntracked = true;
        else contributesContent = true;
      }
    }

    if (contributesContent) return 'content';
    if (holdsUntracked) {
      if (relBase) untrackedOnlyDirs.push(relBase);
      return 'untrackedOnly';
    }
    if (relBase) empty.push(relBase);
    return 'empty';
  };

  walk(absPath, '');

  // Report only the shallowest directory of each untracked-only subtree: naming
  // `var/` and `var/run/` separately is the same fact twice.
  const untrackedRoots = untrackedOnlyDirs
    .filter((d) => !untrackedOnlyDirs.some((other) => other !== d && d.startsWith(`${other}/`)))
    .sort();
  if (untrackedRoots.length > 0) {
    warnings.push(
      `Excluded ${untrackedRoots.length} directory(ies) whose only contents are untracked files: ${summarizePaths(untrackedRoots)}. ` +
        'They are absent from the workspace because git has no record of them, so a fresh clone would not have them either. ' +
        'Commit a placeholder such as .gitkeep if the build needs the directory to exist.'
    );
  }

  empty.sort();
  return empty;
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
 *
 * `options.includeUntracked` (default `true`, preserving the historical
 * behaviour of every existing caller) selects whether untracked-but-not-ignored
 * files participate. Pass `false` for a certification run so that leftover build
 * or test output cannot alter the tree digest; pass `true` for an --allow-dirty
 * development run, where the workspace must mirror what is on disk. It applies
 * only to the git strategy: the filesystem fallback has no notion of tracking
 * and always reports what it finds, minus FALLBACK_IGNORED_NAMES.
 */
export function enumerateSource(sourcePath, options = {}) {
  const { includeUntracked = true } = options;
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
      files = gitEnumerate(absPath, includeUntracked);
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
