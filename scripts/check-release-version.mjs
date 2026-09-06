import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const packages = ['release-harness', 'release-harness-core', 'release-harness-schemas'];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function checkReleaseVersion(root = repo, ref = process.env.GITHUB_REF ?? '') {
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const json = (name) => JSON.parse(read(name));
  const manifests = packages.map((name) => json(`packages/${name}/package.json`));
  const version = manifests[0].version;
  assert.equal(typeof version, 'string', 'release version must be a string');
  assert.match(version, semver, 'release version must be valid SemVer');
  const lock = json('package-lock.json');
  const workspace = json('package.json');
  assert.equal(workspace.private, true, 'workspace root must remain private');
  assert.equal(workspace.version, '1.0.0', 'private root version is independent');
  assert.equal(workspace.engines?.node, '>=20', 'workspace Node floor');
  assert.equal(lock.version, workspace.version, 'lock root version');
  for (const [i, manifest] of manifests.entries()) {
    const name = packages[i];
    assert.equal(manifest.name, `@xibodev/${name}`, `${name}: package identity`);
    assert.equal(manifest.version, version, `${name}: release version mismatch`);
    assert.equal(manifest.engines?.node, '>=20', `${name}: Node floor`);
  }
  for (const [from, to] of [[0, 1], [0, 2], [1, 2]]) {
    assert.equal(manifests[from].dependencies?.[manifests[to].name], version, `${packages[from]}: exact internal pin for ${packages[to]}`);
  }
  assert.equal(manifests[0].peerDependencies?.playwright, '>=1.50.0', 'Playwright peer floor');
  assert.equal(manifests[0].peerDependenciesMeta?.playwright?.optional, true, 'Playwright peer remains optional');
  for (const [name, manifest] of [['', workspace], ...packages.map((name, i) => [`packages/${name}`, manifests[i]])]) {
    for (const key of ['version', 'engines', 'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      assert.deepEqual(lock.packages?.[name]?.[key], manifest[key], `${name || 'root'}: lock ${key} mismatch`);
    }
  }
  const cliVersion = /^const HARNESS_VERSION = '([^']+)';$/m.exec(read('packages/release-harness-core/src/cli.js'))?.[1];
  assert.equal(cliVersion, version, 'CLI HARNESS_VERSION must match packages');
  if (ref.startsWith('refs/tags/')) {
    const tag = ref.slice('refs/tags/'.length);
    assert.ok([`v${version}`, `release-harness-v${version}`].includes(tag), `release tag ${tag} must match ${version}`);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Release metadata verified: ${checkReleaseVersion()}`);
}
