import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { enumerateSource } from './source-enumerator.js';

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
   */
  computeTreeDigest(dir) {
    const absPath = path.resolve(dir);
    const hash = crypto.createHash('sha256');
    const { files } = enumerateSource(absPath);

    for (const rel of files) {
      const full = path.join(absPath, rel);
      let content;
      try {
        content = fs.readFileSync(full);
      } catch {
        continue; // Unreadable, a symlink target, or vanished between calls
      }
      hash.update(`${rel}:${crypto.createHash('sha256').update(content).digest('hex')}
`);
    }

    return hash.digest('hex');
  }

  getSourceInfo(sourceRepoPath) {
    const absPath = path.resolve(sourceRepoPath);
    if (!fs.existsSync(absPath)) {
      return {
        path: absPath,
        exists: false,
        commitSha: 'MISSING',
        isClean: false,
        dirtyFiles: ['DIRECTORY_DOES_NOT_EXIST'],
        isIndependentRepo: false,
        treeDigest: '0000000000000000000000000000000000000000000000000000000000000000',
      };
    }

    let commitSha = '0000000000000000000000000000000000000000';
    let isClean = true;
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

    try {
      const status = execSync('git status --porcelain --no-ahead-behind -uno', {
        cwd: absPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();

      if (status.length > 0) {
        isClean = false;
        for (const line of status.split('\n')) {
          if (line.trim()) dirtyFiles.push(line.trim());
        }
      }
    } catch {
      // Git status failed
    }

    const treeDigest = this.computeTreeDigest(absPath);
    return {
      path: absPath,
      exists: true,
      commitSha,
      isClean,
      dirtyFiles,
      isIndependentRepo,
      gitTopLevel,
      treeDigest,
    };
  }

  resolveMultiRepoGraph(topology, baseDir) {
    const repos = topology.repositories || [];
    const resolvedNodes = [];
    const errors = [];
    const graphHasher = crypto.createHash('sha256');

    for (const repo of repos) {
      const repoDir = repo.source.local_path
        ? path.resolve(baseDir, repo.source.local_path)
        : path.resolve(baseDir, repo.repo_id);

      const info = this.getSourceInfo(repoDir);

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

      graphHasher.update(`${repo.repo_id}:${info.commitSha}:${info.isClean}:${info.treeDigest}\n`);

      resolvedNodes.push({
        repo_id: repo.repo_id,
        path: repoDir,
        exists: true,
        missing: false,
        commit_sha: info.commitSha,
        expected_sha: repo.source.expected_sha,
        sha_mismatch: shaMismatch,
        is_clean: info.isClean,
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
   */
  materializeRepo(sourceRepoPath, destinationSubdir = 'source') {
    const sourceAbs = path.resolve(sourceRepoPath);
    const targetDir = path.join(this.workspaceRoot, destinationSubdir);
    fs.mkdirSync(targetDir, { recursive: true });

    const startedAt = Date.now();
    const info = this.getSourceInfo(sourceAbs);
    const { files, strategy, warnings } = enumerateSource(sourceAbs);

    let byteCount = 0;
    for (const rel of files) {
      const srcPath = path.join(sourceAbs, rel);
      const dstPath = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });

      let stat;
      try {
        stat = fs.lstatSync(srcPath);
      } catch {
        continue; // Vanished between enumeration and copy
      }

      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(srcPath);
        try {
          fs.symlinkSync(linkTarget, dstPath);
        } catch {
          // Windows without developer mode cannot create symlinks. Copy the
          // resolved content so the build still sees a real file.
          try {
            fs.copyFileSync(srcPath, dstPath);
            byteCount += fs.statSync(dstPath).size;
          } catch {
            // Dangling link - nothing to materialize
          }
        }
      } else if (stat.isFile()) {
        fs.copyFileSync(srcPath, dstPath);
        byteCount += stat.size;
      }
    }

    this.materializedSubdir = targetDir;

    return {
      targetDir,
      sourceInfo: info,
      stats: {
        fileCount: files.length,
        byteCount,
        elapsedMs: Date.now() - startedAt,
        strategy,
        warnings,
      },
    };
  }

  cleanup() {
    const target = this.materializedSubdir || this.workspaceRoot;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
