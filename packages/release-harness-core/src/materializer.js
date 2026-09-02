import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { enumerateSource, enumerateEmptyDirectories } from './source-enumerator.js';

/**
 * Detached source workspace materializer.
 * Creates an external, isolated copy of source code for testing.
 * Strictly guarantees that the original source repo and its .git directory are NEVER modified.
 */
export class SourceMaterializer {
  constructor(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /**
   * Content digest over the SAME file list the workspace copy materializes.
   * Sharing `enumerateSource` is the point: a digest computed over a different
   * set than the one built is not a provenance record. There is deliberately
   * no depth bound - a change at any depth must move the digest.
   *
   * `files` is an optional pre-computed enumeration. When supplied, no
   * enumeration of its own is performed, which is what lets `materializeRepo`
   * hash and copy the one identical list: two enumerations, however
   * deterministic, are two observations of a mutable filesystem, and anything
   * created, deleted or renamed between them puts a file in one set and not the
   * other. Omitting it preserves the standalone one-argument behaviour.
   */
  computeTreeDigest(dir, files = null) {
    const absPath = path.resolve(dir);
    const hash = crypto.createHash('sha256');
    const list = files === null || files === undefined ? enumerateSource(absPath).files : files;

    for (const rel of list) {
      const full = path.join(absPath, rel);
      let content;
      try {
        content = fs.readFileSync(full);
      } catch {
        continue; // Unreadable, a symlink target, or vanished between calls
      }
      hash.update(`${rel}:${crypto.createHash('sha256').update(content).digest('hex')}\n`);
    }

    return hash.digest('hex');
  }

  /**
   * `enumeration` is an optional pre-computed `enumerateSource` result, passed
   * straight through to `computeTreeDigest` so that a caller which has already
   * enumerated does not enumerate a second time. Omitting it preserves the
   * standalone one-argument behaviour used by `cli.js` and
   * `resolveMultiRepoGraph`.
   */
  getSourceInfo(sourceRepoPath, enumeration = null) {
    const absPath = path.resolve(sourceRepoPath);
    if (!fs.existsSync(absPath)) {
      return {
        path: absPath,
        exists: false,
        commitSha: 'MISSING',
        isClean: false,
        statusResolved: false,
        dirtyFiles: ['DIRECTORY_DOES_NOT_EXIST'],
        isIndependentRepo: false,
        treeDigest: '0000000000000000000000000000000000000000000000000000000000000000',
      };
    }

    let commitSha = '0000000000000000000000000000000000000000';
    // Fails closed: a tree is clean only when `git status` was actually run and
    // actually came back empty. Defaulting to `true` with a swallowed catch
    // certified every tree whose status could not be established - a missing git
    // executable, a timeout, a permission error - as clean, which is the one
    // answer the certification gate must never be given for free.
    let isClean = false;
    let statusResolved = false;
    let isIndependentRepo = false;
    let gitTopLevel = null;
    const dirtyFiles = [];

    try {
      gitTopLevel = execSync('git rev-parse --show-toplevel', {
        cwd: absPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();

      // Check if git toplevel matches this exact directory
      if (path.resolve(gitTopLevel) === absPath) {
        isIndependentRepo = true;
      }

      commitSha = execSync('git rev-parse HEAD', {
        cwd: absPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      // Not a git repo or git not available
    }

    // `-uno` is deliberately ABSENT. Untracked-but-not-ignored files ARE
    // materialized and digested by the enumerator on an --allow-dirty run, so
    // suppressing them here would let the digest cover files the cleanliness
    // gate never looked at. Ignored files remain excluded by git's own default,
    // which matches what the enumerator excludes.
    try {
      const status = execSync('git status --porcelain --no-ahead-behind', {
        cwd: absPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();

      statusResolved = true;
      if (status.length === 0) {
        isClean = true;
      } else {
        for (const line of status.split('\n')) {
          if (line.trim()) dirtyFiles.push(line.trim());
        }
      }
    } catch {
      // Status unresolvable - `isClean` stays false. The sentinel is recorded in
      // `dirtyFiles` so a run manifest names the reason rather than showing a
      // tree that is dirty with nothing listed against it.
      dirtyFiles.push('GIT_STATUS_UNRESOLVED');
    }

    const treeDigest = this.computeTreeDigest(absPath, enumeration ? enumeration.files : null);
    return {
      path: absPath,
      exists: true,
      commitSha,
      isClean,
      statusResolved,
      dirtyFiles,
      isIndependentRepo,
      gitTopLevel,
      treeDigest,
    };
  }

  /**
   * Resolves every repository in a multi-repo product graph.
   *
   * `options.includeUntracked` is forwarded to each repository's enumeration so
   * the graph digest is computed under the same inclusion rules the subsequent
   * materialization will use. Without it a certification run would exclude
   * untracked files from the workspace while still digesting them, and the
   * recorded provenance would describe a tree that was never materialized.
   */
  resolveMultiRepoGraph(topology, baseDir, options = {}) {
    const repos = topology.repositories || [];
    const resolvedNodes = [];
    const errors = [];
    const graphHasher = crypto.createHash('sha256');

    for (const repo of repos) {
      const repoDir = repo.source.local_path
        ? path.resolve(baseDir, repo.source.local_path)
        : path.resolve(baseDir, repo.repo_id);

      const info = this.getSourceInfo(repoDir, enumerateSource(repoDir, options));

      // EVERY declared repository contributes, including a missing one. Skipping
      // the absent case - as a `continue` above this line did - let a graph
      // declaring three repositories, one of them absent, digest identically to
      // a graph that only ever declared two: the graph digest stopped being a
      // record of what was declared. The missing-directory sentinel supplies a
      // distinct, stable contribution ('MISSING' plus an all-zero tree digest),
      // so the two graphs separate.
      graphHasher.update(`${repo.repo_id}:${info.commitSha}:${info.isClean}:${info.treeDigest}\n`);

      if (!info.exists) {
        errors.push(`Repository node "${repo.repo_id}" not found at ${repoDir}`);
        resolvedNodes.push({
          repo_id: repo.repo_id,
          path: repoDir,
          exists: false,
          missing: true,
          commit_sha: 'MISSING',
          expected_sha: repo.source.expected_sha,
          sha_mismatch: true,
          is_clean: false,
          status_resolved: info.statusResolved,
          dirty_files: info.dirtyFiles,
          tree_digest: info.treeDigest,
        });
        continue;
      }

      let shaMismatch = false;
      if (repo.source.revision_policy === 'exact_sha' && repo.source.expected_sha) {
        if (info.commitSha !== repo.source.expected_sha) {
          shaMismatch = true;
          errors.push(`Repository "${repo.repo_id}" SHA mismatch: expected ${repo.source.expected_sha}, got ${info.commitSha}`);
        }
      }

      resolvedNodes.push({
        repo_id: repo.repo_id,
        path: repoDir,
        exists: true,
        missing: false,
        commit_sha: info.commitSha,
        expected_sha: repo.source.expected_sha,
        sha_mismatch: shaMismatch,
        is_clean: info.isClean,
        status_resolved: info.statusResolved,
        dirty_files: info.dirtyFiles,
        is_independent_repo: info.isIndependentRepo,
        git_top_level: info.gitTopLevel,
        tree_digest: info.treeDigest,
      });
    }

    return {
      ok: errors.length === 0,
      errors,
      graph_digest: graphHasher.digest('hex'),
      nodes: resolvedNodes,
    };
  }

  /**
   * Materializes a detached copy of the repository into the external workspace.
   * Excludes source .git directory to guarantee isolation.
   *
   * The tree is enumerated EXACTLY ONCE and that one list feeds both the digest
   * and the copy. Enumerating twice - as this did previously, once via
   * `getSourceInfo` and once for the copy - leaves a window (measured at several
   * seconds on a real repo, spanning ~11 git subprocess spawns) in which a file
   * can be written, deleted or renamed. The digest would then be a faithful
   * record of a tree that was never materialized: exactly the property this
   * class exists to establish. A single list makes divergence impossible by
   * construction rather than unlikely by timing.
   *
   * `options.includeUntracked` (default `true`) selects whether
   * untracked-but-not-ignored files are materialized and digested. It is passed
   * to the single enumeration, so it cannot differ between the digest and the
   * copy. `handleRunLocal` passes `!!flags['allow-dirty']`, so a certification
   * run excludes leftover build and test output while an --allow-dirty
   * development run still tests what is actually on disk.
   */
  materializeRepo(sourceRepoPath, destinationSubdir = 'source', options = {}) {
    const { includeUntracked = true } = options;
    const sourceAbs = path.resolve(sourceRepoPath);
    const targetDir = path.join(this.workspaceRoot, destinationSubdir);
    fs.mkdirSync(targetDir, { recursive: true });
    // Recorded before any work, not after: a failure part-way through must still
    // leave `cleanup()` able to reclaim what has already been written. An
    // accumulator rather than a single slot, because a multi-repo graph calls
    // this once per repository and a single slot would leave `cleanup()` aware
    // only of the last one.
    if (!this.materializedSubdirs) this.materializedSubdirs = [];
    if (!this.materializedSubdirs.includes(targetDir)) this.materializedSubdirs.push(targetDir);

    const startedAt = Date.now();
    const enumeration = enumerateSource(sourceAbs, { includeUntracked });
    const { files, strategy } = enumeration;
    const warnings = [...enumeration.warnings];
    const info = this.getSourceInfo(sourceAbs, enumeration);

    let byteCount = 0;
    let copiedCount = 0;
    let skippedCount = 0;

    /**
     * Report a path that was enumerated but not materialized. Silence here is
     * the worst outcome available: `fileCount` would count a file absent from
     * disk and the digest would certify content the workspace does not hold.
     */
    const skip = (rel, reason, err) => {
      skippedCount += 1;
      const code = err && err.code ? err.code : err && err.message ? err.message : 'unknown error';
      warnings.push(
        `Skipped "${rel}" during materialization: ${reason} (${code}). ` +
          'The tree digest covers this path but the workspace does not contain it.'
      );
    };

    /**
     * `copyFileSync` is not atomic: a failure part-way leaves a truncated
     * destination that looks like a complete file to everything downstream,
     * including any consumer of the digest that certifies it. Remove it.
     */
    const discardPartial = (dstPath) => {
      try {
        fs.rmSync(dstPath, { force: true });
      } catch {
        // Best effort - the skip warning already names the path.
      }
    };

    for (const rel of files) {
      const srcPath = path.join(sourceAbs, rel);
      const dstPath = path.join(targetDir, rel);

      try {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      } catch (err) {
        skip(rel, 'the destination directory could not be created', err);
        continue;
      }

      // Everything from here to the end of the iteration sits in the race
      // window the enumeration opened: the file may vanish, be replaced, or be
      // held open by another process (a Playwright trace or video mid-write
      // raises EBUSY on Windows). None of that may abort the run.
      let stat;
      try {
        stat = fs.lstatSync(srcPath);
      } catch (err) {
        skip(rel, 'it vanished or became unreadable between enumeration and copy', err);
        continue;
      }

      if (stat.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = fs.readlinkSync(srcPath);
        } catch (err) {
          skip(rel, 'the symlink could not be read', err);
          continue;
        }

        try {
          fs.symlinkSync(linkTarget, dstPath);
          copiedCount += 1;
        } catch {
          // Windows without developer mode cannot create symlinks. Copy the
          // resolved content so the build still sees a real file.
          try {
            fs.copyFileSync(srcPath, dstPath);
            byteCount += fs.statSync(dstPath).size;
            copiedCount += 1;
          } catch (err) {
            discardPartial(dstPath);
            skip(rel, 'the symlink could not be recreated and its target could not be copied', err);
          }
        }
      } else if (stat.isFile()) {
        try {
          fs.copyFileSync(srcPath, dstPath);
          byteCount += stat.size;
          copiedCount += 1;
        } catch (err) {
          discardPartial(dstPath);
          skip(rel, 'the file could not be copied', err);
        }
      } else {
        skip(rel, 'it is no longer a regular file', { code: 'ENOTFILE' });
      }
    }

    // Git does not track empty directories, so they must be recreated
    // separately or a build expecting uploads/ or tmp/cache/ fails in the
    // workspace but not locally. "Empty" here means empty from the WORKSPACE's
    // perspective - a directory whose only contents are ignored, or whose only
    // contents are untracked on a run that excludes untracked files, contributes
    // no copied file and would otherwise be absent with nothing said. They hold
    // no content and therefore do NOT participate in the tree digest - git's own
    // model does not track them.
    //
    // `includeUntracked` is threaded through so this walk judges emptiness by
    // the SAME rule the file enumeration used. Judging by a different rule is
    // how a directory ends up neither copied nor recreated.
    let emptyDirCount = 0;
    for (const rel of enumerateEmptyDirectories(sourceAbs, warnings, { includeUntracked })) {
      const dstPath = path.join(targetDir, rel);
      let existing = null;
      try {
        existing = fs.lstatSync(dstPath);
      } catch {
        // Absent, which is the ordinary case - fall through and create it.
      }
      if (existing) {
        // Already a directory: nothing to do, and nothing worth saying.
        if (existing.isDirectory()) continue;
        // A file occupies the path the source holds a directory at. Creating it
        // is impossible and skipping silently leaves the workspace structurally
        // unlike the source with no trace of why.
        warnings.push(
          `Could not recreate empty source directory "${rel}" in the workspace: a non-directory already occupies that path. ` +
            'The workspace structure differs from the source tree at this path.'
        );
        continue;
      }
      try {
        fs.mkdirSync(dstPath, { recursive: true });
        emptyDirCount += 1;
      } catch (err) {
        warnings.push(
          `Could not recreate empty source directory "${rel}" in the workspace (${err && err.code ? err.code : err.message}).`
        );
      }
    }

    return {
      targetDir,
      sourceInfo: info,
      stats: {
        // What is actually on disk in the workspace. `enumeratedCount` is what
        // the digest covers; the two are equal unless something was skipped,
        // and every difference is named in `warnings`.
        fileCount: copiedCount,
        enumeratedCount: files.length,
        skippedCount,
        emptyDirCount,
        byteCount,
        elapsedMs: Date.now() - startedAt,
        strategy,
        warnings,
      },
    };
  }

  /**
   * Materializes EVERY repository in a multi-repo product graph, each into its
   * own workspace subdirectory named for its `repo_id`.
   *
   * Level 1 already binds a multi-repo product per repository. Level 2 called
   * `materializeRepo(cwd, 'source')` regardless of `topology_type`, so a
   * declared multi_repo product was certified against one repository - the one
   * the operator happened to be standing in - while its manifest claimed the
   * graph. Certification then rested on a tree that was never fully inspected.
   *
   * Resolution comes first and is authoritative: when the graph does not resolve
   * (a repository absent, or an exact_sha that does not match) NOTHING is
   * materialized. Copying a partial graph would leave a workspace that looks
   * like a product and is not one, and the caller must decide on the errors
   * rather than on whatever happened to be copyable.
   *
   * `options` is forwarded unchanged to every `materializeRepo` call, so
   * `includeUntracked` cannot differ between repositories in one graph.
   */
  materializeGraph(topology, baseDir, options = {}) {
    const graph = this.resolveMultiRepoGraph(topology, baseDir, options);
    const workspaces = [];

    if (graph.ok) {
      for (const repo of topology.repositories || []) {
        const localPath = (repo.source && repo.source.local_path) || repo.repo_id;
        const repoPath = path.resolve(baseDir, localPath);
        // POSIX-joined so the subdirectory name matches the graph's own spelling
        // on every platform; `path.join` normalizes the separator for the fs.
        const res = this.materializeRepo(repoPath, path.join('sources', repo.repo_id), options);
        workspaces.push({ repo_id: repo.repo_id, ...res });
      }
    }

    return {
      ok: graph.ok,
      errors: graph.errors,
      graphDigest: graph.graph_digest,
      nodes: graph.nodes,
      workspaces,
    };
  }

  /**
   * Reclaim what this materializer created.
   *
   * `cli.js` builds `evidenceRoot/workspaces/<runId>` and hands it to the
   * constructor as the workspace root, so the run's whole workspace is ours to
   * remove - including sibling artifacts written beside `source/`, which a
   * subdir-scoped cleanup left behind along with the run directory itself.
   * Removing the root is only safe because it is per-run and materializer-owned,
   * so we remove it only when we actually materialized into it: a materializer
   * that never ran must not delete a caller's directory.
   *
   * The guard reads the plural accumulator, so a multi-repo graph that
   * materialized N repositories under `sources/` is reclaimed by the same single
   * root removal. Removing each recorded subdirectory INSTEAD of the root would
   * be a regression: it leaves the run directory itself and any sibling artifact
   * written beside `sources/` behind, which is the defect the root removal
   * exists to close.
   */
  cleanup() {
    if (!this.materializedSubdirs || this.materializedSubdirs.length === 0) return;
    const target = this.workspaceRoot;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    this.materializedSubdirs = [];
  }
}
