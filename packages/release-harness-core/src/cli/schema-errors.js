/**
 * Rendering schema errors a person can act on.
 *
 * AJV stays authoritative -- this adds no second validator and makes no
 * judgement about what is valid. It only translates.
 *
 * D20: an adoption agent received `must NOT have additional properties` with no
 * indication of WHICH property, in an artifact with eight nested objects. That
 * is a true statement that cannot be acted on. It compounded D19, where the
 * vocabulary was strict but invisible: strict validation that cannot say what
 * it rejected teaches an author to guess, which is the failure the whole
 * project exists to prevent.
 *
 * The keywords prioritised here are the ones authors actually hit:
 * additionalProperties, required, enum/const, pattern, and the discriminated
 * assertion branches. Anything else falls through to AJV's own wording rather
 * than being paraphrased badly.
 */

/** `/proposition/assertions/0/expect` -> `proposition.assertions[0].expect` */
function toPath(instancePath) {
  if (!instancePath) return '';
  return instancePath
    .split('/')
    .filter(Boolean)
    .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
    .join('')
    .replace(/^\./, '');
}

/** Where the reader should look, in their own file. */
function locate(artifact, instancePath) {
  const p = toPath(instancePath);
  return p ? `${artifact}: ${p}` : artifact;
}

/**
 * One AJV error, rendered.
 *
 * Returns null when the error adds nothing a reader can use -- AJV emits a
 * cascade for a failed `if/then`, and repeating every branch buries the one
 * line that matters.
 */
function renderOne(err, artifact) {
  const where = locate(artifact, err.instancePath);

  switch (err.keyword) {
    case 'additionalProperties': {
      const prop = err.params.additionalProperty;
      const allowed = Object.keys(err.parentSchema?.properties ?? {});
      return [
        `${where}`,
        `  \`${prop}\` is not a field this artifact has.`,
        allowed.length ? `  Allowed here: ${allowed.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'required':
      return [
        `${where}`,
        `  \`${err.params.missingProperty}\` is required and is missing.`,
      ].join('\n');

    case 'enum': {
      const allowed = err.params.allowedValues ?? [];
      return [
        `${where}`,
        `  not one of the permitted values.`,
        allowed.length ? `  Allowed: ${allowed.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'const':
      return [`${where}`, `  must be exactly ${JSON.stringify(err.params.allowedValue)}.`].join('\n');

    case 'pattern':
      return [
        `${where}`,
        `  does not match the required form.`,
        `  Expected pattern: ${err.params.pattern}`,
      ].join('\n');

    case 'minItems':
      return [`${where}`, `  must contain at least ${err.params.limit}.`].join('\n');

    case 'minLength':
      return [`${where}`, `  must not be empty.`].join('\n');

    case 'minProperties':
      return [`${where}`, `  must state at least one expectation.`].join('\n');

    case 'dependencies':
      return [
        `${where}`,
        `  \`${err.params.missingProperty}\` is required when \`${err.params.property}\` is present.`,
      ].join('\n');

    // The discriminated-assertion cascade. `if` tells the reader nothing, and
    // the `then` failure is already reported by whichever keyword inside it
    // actually failed.
    case 'if':
    case 'anyOf':
    case 'oneOf':
      return null;

    default:
      return [`${where}`, `  ${err.message}`].join('\n');
  }
}

/**
 * Render a list of AJV errors for a human.
 *
 * The structured errors are always preserved separately for `--json`; this is
 * presentation only, and never the authority on what was wrong.
 */
export function renderSchemaErrors(errors, artifact) {
  const rendered = [];
  const seen = new Set();

  for (const err of errors ?? []) {
    const text = renderOne(err, artifact);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    rendered.push(text);
  }

  return rendered;
}
