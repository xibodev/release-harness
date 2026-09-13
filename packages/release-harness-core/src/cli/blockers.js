/**
 * Rendering blockers for humans. One implementation, used everywhere.
 *
 * D1 and D17 were the same defect found twice: `validate` inlined the full text
 * of every blocker, which for five thorough semantic questions meant 3,370
 * characters and a 938-character line. I fixed it in `validate.js` and left
 * `doctor.js` untouched, so the same draft rendered at 180 characters per line
 * in one command and 916 in the other.
 *
 * The structural point: core owns the blockers, the CLI owns their appearance,
 * and there is exactly one place that decides what appearance means. Anything
 * that displays a blocker imports this.
 *
 * The machine-readable form is never truncated. Only the human rendering is,
 * and it always says where the full text lives -- because a summary that hides
 * the thing it summarises just moves the problem.
 */

/** First line, clipped, with an explicit ellipsis so truncation is visible. */
export function summariseBlocker(detail, max = 150) {
  const firstLine = String(detail).split(String.fromCharCode(10))[0].trim();
  return firstLine.length <= max ? firstLine : `${firstLine.slice(0, max - 1)}…`;
}

/**
 * Render a blocker list to an output sink.
 *
 * @param {object} out           the CLI output helper
 * @param {Array}  blockers      structured blockers from assessDraft
 * @param {object} [options]
 * @param {string} [options.fullTextAt]  path where the untruncated text lives
 */
export function renderBlockers(out, blockers, { fullTextAt } = {}) {
  for (const b of blockers) {
    out.detail(`[${b.kind}] ${summariseBlocker(b.detail)}`);
  }
  if (fullTextAt && blockers.some((b) => String(b.detail).length > 150)) {
    out.blank();
    out.detail(`Full text: ${fullTextAt}`);
  }
}

/**
 * The one-line headline for a draft's state.
 *
 * The vocabulary is deliberate and consistent across commands: a draft that is
 * merely unfinished is never called invalid, because an author who is told they
 * made a mistake when they did not learns to distrust the tool.
 */
export function describeState(name, assessment) {
  const n = assessment.blockers.length;
  const plural = n === 1 ? '' : 's';

  switch (assessment.state) {
    case 'INVALID':
      return `Draft "${name}" is not valid -- ${n} problem${plural}:`;
    case 'BLOCKED':
      return `Draft "${name}" is valid but not ready to accept -- ${n} blocker${plural}:`;
    case 'ACCEPTABLE':
      return `Draft "${name}" is ready to accept.`;
    default:
      return `Draft "${name}": ${assessment.state}`;
  }
}
