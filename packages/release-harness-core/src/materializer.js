import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_NAMES = new Set([
  '.git',
  '.brains',
  '.quality-run',
  'node_modules',
  '.pytest_cache',
  '.ruff_cache',
  'test-results',
  'playwright-report',
  'uploads',
  'research',
  'brand',
  'docs',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.turbo',
  '__pycache__',
  '.cache',
  'coverage',
]);

/**
 * Detached source workspace materializer.
 * Creates an external, isolated copy of source code for testing.
 * Strictly guarantees that the original source repo and its .git directory are NEVER modified.
 */
export class SourceMaterializer {
  constructor(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  computeTreeDigest(dir, maxDepth = 4) {
    const hash = crypto.createHash('sha256');
    const files = [];

    const walk = (d, depth = 0) => {
      if (depth > maxDepth || !fs.existsSync(d)) return;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (IGNORED_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) {
          continue;
        }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };

    walk(dir, 0);
    files.sort();
    for (const file of files) {
      const rel = path.relative(dir, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file);
      hash.update(`${rel}:${crypto.createHash('sha256').update(content).digest('hex')}\n`);
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

    const info = this.getSourceInfo(sourceAbs);

    // Copy files recursively, ignoring .git, .brains, node_modules build caches
    const copyRecursive = (src, dst) => {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) {
          continue; // Skip VCS & build caches
        }
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);

        if (entry.isDirectory()) {
          fs.mkdirSync(dstPath, { recursive: true });
          copyRecursive(srcPath, dstPath);
        } else if (entry.isFile()) {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    };

    copyRecursive(sourceAbs, targetDir);

    return {
      targetDir,
      sourceInfo: info,
    };
  }

  cleanup() {
    if (fs.existsSync(this.workspaceRoot)) {
      fs.rmSync(this.workspaceRoot, { recursive: true, force: true });
    }
  }
}
