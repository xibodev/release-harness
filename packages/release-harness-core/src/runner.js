import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probeHttp, probeTcp } from './probes.js';

/**
 * Production OCI Image content digest resolver.
 */
export function resolveImageContentDigest(imageName) {
  try {
    const inspectRepo = execSync(`docker inspect --format="{{index .RepoDigests 0}}" ${imageName}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inspectRepo && inspectRepo.includes('@sha256:')) {
      return inspectRepo.split('@')[1];
    }
  } catch {
    // try fallback to image ID
  }

  try {
    const inspectId = execSync(`docker inspect --format="{{.Id}}" ${imageName}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inspectId && inspectId.startsWith('sha256:')) {
      return inspectId;
    }
  } catch {
    // inspect failed
  }

  return 'unknown';
}

/**
 * Manages the Docker Compose lifecycle with unique run_id isolation.
 */
export class DockerComposeRunner {
  constructor({ composeFile, runId, workingDir, portOffset = 0 }) {
    this.composeFile = path.resolve(composeFile);
    this.runId = runId;
    this.projectName = `rh-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    this.workingDir = path.resolve(workingDir);
    this.portOffset = portOffset;
    this.running = false;
    this.activeContainers = [];
  }

  execCompose(args, options = {}) {
    const fullArgs = ['compose', '-p', this.projectName, '-f', this.composeFile, ...args];
    try {
      return execSync(`docker ${fullArgs.join(' ')}`, {
        cwd: this.workingDir,
        encoding: 'utf8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: this.projectName,
          RUN_ID: this.runId,
          PORT_OFFSET: String(this.portOffset),
        },
      });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`docker compose ${args.join(' ')} failed: ${stderr}`);
    }
  }

  async up() {
    // 1. Build and start containers in background
    this.execCompose(['up', '-d', '--build']);
    this.running = true;

    // 2. Query active containers and inspect OCI content digests
    const psJson = this.execCompose(['ps', '--format', 'json']);
    const artifacts = [];

    try {
      const lines = psJson.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const item = JSON.parse(line);
        const serviceName = item.Service || item.Name;
        const image = item.Image;
        const contentDigest = resolveImageContentDigest(image);

        artifacts.push({
          id: `service-${serviceName}`,
          service_id: serviceName,
          artifact_type: 'oci_image',
          content_digest: contentDigest,
          tag_aliases: [image],
        });
      }
    } catch {
      // ignore ps parsing error
    }

    return { artifacts };
  }

  async healthCheckServices(services, timeoutSeconds = 60) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const results = [];

    for (const service of services) {
      if (!service.health_probe) continue;
      const probe = service.health_probe;
      const port = probe.port ? probe.port + this.portOffset : 80;
      let healthy = false;
      let message = 'Unchecked';

      while (Date.now() < deadline) {
        if (probe.type === 'http') {
          const res = await probeHttp({
            host: probe.host || '127.0.0.1',
            port,
            path: probe.path || '/health',
            scheme: probe.scheme || 'http',
            expectedStatus: probe.expected_status || 200,
            timeoutMs: 3000,
          });
          healthy = res.ok;
          message = res.message;
        } else if (probe.type === 'tcp') {
          const res = await probeTcp({ host: probe.host || '127.0.0.1', port, timeoutMs: 3000 });
          healthy = res.ok;
          message = res.message;
        } else {
          healthy = true;
          message = 'Container running';
        }

        if (healthy) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      results.push({
        service_id: service.id,
        healthy,
        message,
        port,
      });

      if (!healthy) {
        throw new Error(`Service "${service.id}" health-check failed: ${message}`);
      }
    }

    return results;
  }

  teardown() {
    if (!this.running) return;
    try {
      // Remove all containers, networks, and volumes scoped to this project name
      this.execCompose(['down', '-v', '--remove-orphans']);
    } catch (err) {
      console.error(`Teardown warning for ${this.projectName}: ${err.message}`);
    } finally {
      this.running = false;
    }
  }
}
