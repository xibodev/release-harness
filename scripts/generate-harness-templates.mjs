// Retired: importing the sibling AOM checkout overwrote package-owned skill
// namespaces and scenario guidance. Keep old invocations non-destructive.
console.error('Template generation has been retired. Edit packages/release-harness-core/templates directly.');
console.error('templates/agents/release-conductor.md is the canonical agent; init renders runtime frontmatter using src/agent-templates.js.');
process.exitCode = 1;
