// Each suite is awaited in turn. A static `import` of a module using top-level
// await suspends that module while its siblings run, which interleaved the
// output of three suites and made it unclear which file produced which line.
// Sequential dynamic imports also guarantee every assertion has resolved
// before the banner below claims they all passed.
await import('./evaluator.test.js');
await import('./sealer.test.js');
await import('./validator.test.js');
await import('./cli.test.js');
await import('./runtime.test.js');
await import('./security-regressions.test.js');
await import('./proxy-transports.test.js');
await import('./init.test.js');

console.log('\nAll release-harness-core unit & golden tests PASSED!');
