import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Audit explicit skill-local support paths and relative Markdown links. Product
// examples must name the exact path rather than exempting a whole skill directory.
export function assertSkillSupport(skillDir) {
  const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const examples = new Set([...text.matchAll(/Product-owned (?:example|input|output): `([^`]+)`/g)].map((match) => match[1]));
  const references = new Set([
    ...[...text.matchAll(/(?:\.\/)?(?:scripts|references|assets|templates)\/[a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]+/g)].map((match) => match[0]),
    ...[...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]),
  ]);
  for (const reference of references) {
    if (/^(?:[a-z]+:|#)/i.test(reference) || examples.has(reference)) continue;
    const relative = decodeURIComponent(reference.split('#')[0]);
    const target = path.resolve(skillDir, relative);
    const within = path.relative(skillDir, target);
    assert.ok(within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within), `${skillDir}: support escapes skill: ${reference}`);
    assert.ok(fs.existsSync(target), `${skillDir}: missing support ${reference}; ship it or document the exact product-owned example/input/output`);
  }
}
