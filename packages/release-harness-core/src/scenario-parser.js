import fs from 'node:fs';
import { createRequire } from 'node:module';
import { validateScenario } from './validator.js';

const require = createRequire(import.meta.url);

function getYamlParser() {
  const candidateModules = ['yaml', 'js-yaml'];

  for (const modName of candidateModules) {
    try {
      const mod = require(modName);
      if (mod && typeof mod.parse === 'function') return mod.parse.bind(mod);
      if (mod && typeof mod.load === 'function') return mod.load.bind(mod);
    } catch {
      // search next candidate
    }
  }

  return null;
}

const yamlParser = getYamlParser();

/**
 * Parses JSON or YAML-formatted scenario content.
 * Fails closed on any parse or validation error.
 */
export function parseScenarioFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Scenario file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  let parsed = null;

  if (filePath.endsWith('.json')) {
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON in scenario "${filePath}": ${err.message}`);
    }
  } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    if (yamlParser) {
      try {
        parsed = yamlParser(content);
      } catch (err) {
        throw new Error(`Invalid YAML in scenario "${filePath}": ${err.message}`);
      }
    } else {
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`YAML parser unavailable to parse "${filePath}". Please install yaml or provide JSON.`);
      }
    }
  } else {
    throw new Error(`Unsupported scenario file format for "${filePath}". Expected .json, .yaml, or .yml`);
  }

  validateScenario(parsed);
  return parsed;
}
