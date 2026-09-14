// Each suite is awaited in turn. A static `import` of a module using top-level
// await suspends that module while its siblings run, which interleaved the
// output of three suites and made it unclear which file produced which line.
// Sequential dynamic imports also guarantee every assertion has resolved
// before the banner below claims they all passed.
await import('./characterization.test.js');
await import('./contract-identity.test.js');
await import('./negative-evidence.test.js');
await import('./acceptance.test.js');
await import('./attribution.test.js');
await import('./run-chain.test.js');
await import('./vertical-slice.test.js');
await import('./fixture-a-regression.test.js');
await import('./adjudicate.test.js');
await import('./execution-attribution.test.js');
await import('./structural-invariants.test.js');
await import('./accepted-not-ready.test.js');
await import('./lifecycle.test.js');
await import('./lifecycle-cli.test.js');
await import('./multi-session-lifecycle.test.js');
await import('./c4-regressions.test.js');
await import('./d42-windows-bindings.test.js');
await import('./self-adoption.test.js');
await import('./cli.test.js');
await import('./sealer.test.js');
await import('./validator.test.js');

console.log('\nAll release-harness-core unit & golden tests PASSED!');
