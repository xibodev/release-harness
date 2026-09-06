import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { probeHttp, probeTcp } from './probes.js';
import { validateHealthProbe } from './validator.js';
import { SecretRedactor } from './redactor.js';

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
      return this.execDocker(fullArgs, {
        cwd: this.workingDir,
        encoding: 'utf8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: this.projectName,
          RUN_ID: this.runId,
          PORT_OFFSET: String(this.portOffset),
        },
        ...options,
      });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      const error = new Error(`docker compose ${args.join(' ')} failed: ${stderr}`);
      error.code = err.code;
      error.exit_code = err.status;
      throw error;
    }
  }

  execDocker(args, options = {}) {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
  }

  async up() {
    // 1. Build and start containers in background
    // A failed up may still have created containers. Always attempt scoped cleanup.
    this.running = true;
    this.execCompose(['up', '-d', '--build']);

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
    const results = [];

    for (const service of services) {
      if (!service.health_probe) continue;
      const probe = service.health_probe;
      validateHealthProbe(probe, this.portOffset);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) throw new Error('Invalid health-check timeout');
      const started = Date.now();
      const budget = probe.timeout_seconds ?? timeoutSeconds;
      const deadline = started + budget * 1000;
      const port = (probe.port ?? (probe.scheme === 'https' ? 443 : 80)) + this.portOffset;
      let healthy = false;
      let message = 'Unchecked';
      let last = {};
      let attempts = 0;

      while (Date.now() < deadline) {
        attempts++;
        const timeoutMs = Math.max(1, Math.min(3000, deadline - Date.now()));
        if (probe.type === 'http') {
          const res = await probeHttp({
            host: probe.host || '127.0.0.1',
            port,
            path: probe.path || '/health',
            scheme: probe.scheme || 'http',
            expectedStatus: probe.expected_status || 200,
            timeoutMs,
            maxBodyBytes: 64 * 1024,
          });
          last = res;
          healthy = res.ok;
          message = res.message;
        } else if (probe.type === 'tcp') {
          const res = await probeTcp({ host: (probe.host || '127.0.0.1').replace(/^\[|\]$/g, ''), port, timeoutMs });
          last = res;
          healthy = res.ok;
          message = res.message;
        }

        if (healthy) break;
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(1000, deadline - Date.now()))));
      }

      results.push({
        service_id: service.id,
        healthy,
        message,
        port,
        probe_type: probe.type,
        host: probe.host || '127.0.0.1',
        path: probe.path || '/health',
        scheme: probe.scheme || 'http',
        expected_status: probe.expected_status ?? 200,
        status: last.status ?? 0,
        error_code: last.error_code || null,
        attempts,
        elapsed_ms: Date.now() - started,
        timeout_seconds: budget,
      });
    }

    return results;
  }

  collectDiagnostics() {
    const diagnostics = { containers: [], errors: [], logs_omitted: true };
    const deadline = Date.now() + 15000;
    try {
      const ids = this.execCompose(['ps', '-a', '-q'], { timeout: 5000 }).trim().split(/\s+/).filter(Boolean);
      if (ids.length > 50) diagnostics.errors.push('Container diagnostics limited to 50 containers');
      for (const id of ids.slice(0, 50)) {
        if (Date.now() >= deadline) throw new Error('Container diagnostic time budget exhausted');
        if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error('Invalid container identifier from compose ps');
        // Do not collect Config.Env, commands, or arbitrary inspect fields: they may contain secrets.
        const format = '{"id":{{json .Id}},"state":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}}}';
        const item = JSON.parse(this.execDocker(['inspect', '--format', format, id], { timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 64 * 1024 }));
        if (item.project !== this.projectName) throw new Error('Container does not belong to this run');
        const state = item.state || {};
        diagnostics.containers.push({
          id: item.id, service_id: item.service, project: item.project,
          running: state.Running === true, status: state.Status,
          exit_code: state.ExitCode, oom_killed: state.OOMKilled === true,
          error: state.Error ? 'CONTAINER_RUNTIME_ERROR' : '',
          started_at: state.StartedAt, finished_at: state.FinishedAt,
          ports: item.ports || {},
        });
      }
    } catch {
      diagnostics.errors.push('CONTAINER_DIAGNOSTICS_UNAVAILABLE');
    }
    return diagnostics;
  }

  teardown() {
    if (!this.running) return true;
    try {
      // Remove all containers, networks, and volumes scoped to this project name
      this.execCompose(['down', '-v', '--remove-orphans']);
      this.running = false;
      return true;
    } catch (err) {
      console.error(`Teardown warning for ${this.projectName}: ${new SecretRedactor().redactText(err.message)}`);
      return false;
    }
  }
}
