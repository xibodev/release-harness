// Retired entry point; retained to make obsolete invocations fail without writes.
console.error('Template generation has been retired. Edit packages/release-harness-core/templates directly.');
console.error('templates/agents/release-conductor.md is the canonical agent; init renders runtime frontmatter using src/agent-templates.js.');
process.exitCode = 1;
