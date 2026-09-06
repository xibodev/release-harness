import YAML from 'yaml';

// The packaged canonical agent owns the shared body and Claude capability list.
// Foreign frontmatter is never copied into a runtime's generated definition.
export function renderAgentTemplates(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error('Agent template must have YAML frontmatter');
  const metadata = YAML.parse(match[1]);
  if (!metadata || typeof metadata.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name)
      || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error('Agent template requires a valid name and description');
  }
  const mappings = {
    Read: ['read', 'read'], Write: ['write', 'edit'], Edit: ['edit', 'edit'],
    Bash: ['bash', 'execute'], Grep: ['grep', 'search'], Glob: ['glob', 'search'],
    Agent: ['task', 'agent'], WebFetch: ['webfetch', 'web'], WebSearch: ['websearch', 'web'],
    // Copilot discovers skills automatically and reads their instructions with read.
    Skill: ['skill', 'read'],
  };
  const tools = metadata['claude-tools'];
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('Agent template requires a non-empty claude-tools list');
  for (const tool of tools) {
    if (typeof tool !== 'string' || !Object.hasOwn(mappings, tool)) {
      throw new Error(`Unsupported agent tool: ${JSON.stringify(tool)}`);
    }
  }
  const base = { name: metadata.name, description: metadata.description };
  const render = (frontmatter) => `---\n${YAML.stringify(frontmatter)}---\n${match[2]}`;
  const copilot = render({ ...base, tools: [...new Set(tools.map((tool) => mappings[tool][1]))] });
  return {
    claude: render({ ...base, tools: [...new Set(tools)] }),
    opencode: render({ description: metadata.description, mode: 'primary',
      tools: Object.fromEntries(tools.map((tool) => [mappings[tool][0], true])) }),
    github: copilot,
    copilot,
  };
}
