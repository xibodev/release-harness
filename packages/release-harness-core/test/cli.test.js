import assert from 'node:assert';
import { runCli } from '../src/cli.js';

async function captureCli(args) {
  const output = { log: [], error: [], warn: [] };
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };

  try {
    for (const method of Object.keys(output)) {
      console[method] = (...parts) => output[method].push(parts.map(String).join(' '));
    }
    const exitCode = await runCli(args);
    return {
      exitCode,
      stdout: output.log.join('\n'),
      stderr: [...output.error, ...output.warn].join('\n'),
    };
  } finally {
    Object.assign(console, originals);
  }
}

{
  const result = await captureCli(['skills', 'list']);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stdout, /Release-Harness Cognitive Skills \(18 bundled\)/);
  assert.match(result.stdout, /\.claude\/skills\//);
  assert.match(result.stdout, /\.opencode\/skills\//);
  assert.match(result.stdout, /release-harness-project-cartographer/);
  assert.match(result.stdout, /release-harness-scenario-compiler/);
  assert.match(result.stdout, /Scaffold all skills: npx release-harness init --with-agents/);
}

{
  const result = await captureCli(['skills', 'info', 'project-cartographer']);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stdout, /Skill: release-harness-project-cartographer/);
  assert.match(result.stdout, /Capability: Scans the project repository/);
  assert.match(result.stdout, /\.claude\/skills\/release-harness-project-cartographer\/SKILL\.md/);
}

{
  const result = await captureCli(['skills', 'info', 'release-harness-scenario-compiler']);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stdout, /Skill: release-harness-scenario-compiler/);
}

{
  const result = await captureCli(['skills', 'info', 'missing-skill']);
  assert.strictEqual(result.exitCode, 3);
  assert.match(result.stderr, /unknown bundled skill "missing-skill"/);
  assert.match(result.stderr, /release-harness skills list/);
}

console.log('✓ CLI skill discovery list/info behavior verified');
