import { execSync } from 'node:child_process';
import process from 'node:process';

function runCmd(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Discovers and records local toolchain versions.
 */
export function detectToolchain() {
  const toolchain = {
    node: process.version,
    git: null,
    docker_engine: null,
    docker_compose: null,
    playwright: null,
    chromium: null,
    firefox: null,
    webkit: null,
  };

  const gitVer = runCmd('git --version');
  if (gitVer) {
    const m = gitVer.match(/git version ([\d.]+)/);
    toolchain.git = m ? m[1] : gitVer;
  }

  const dockerVer = runCmd('docker --version');
  if (dockerVer) {
    const m = dockerVer.match(/Docker version ([\d.]+)/);
    toolchain.docker_engine = m ? m[1] : dockerVer;
  }

  const composeVer = runCmd('docker compose version');
  if (composeVer) {
    const m = composeVer.match(/Docker Compose version v?([\d.]+)/);
    toolchain.docker_compose = m ? m[1] : composeVer;
  }

  const playwrightVer = runCmd('npx playwright --version');
  if (playwrightVer) {
    const m = playwrightVer.match(/Version ([\d.]+)/i);
    toolchain.playwright = m ? m[1] : playwrightVer;
  }

  return toolchain;
}
