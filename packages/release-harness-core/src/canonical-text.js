/**
 * The logical identity of a canonical TEXT artifact.
 *
 * D32: on Windows, `init` wrote the adoption protocol with CRLF endings while
 * the repository ships LF. The content was byte-for-byte identical after
 * normalisation -- 438 lines, same words -- but the sha256 differed, so an
 * operator checking that the installed protocol had not been tampered with saw
 * every line reported as changed.
 *
 * That is worse than a cosmetic bug. An integrity check whose false alarms are
 * routine teaches the reader to ignore it, and an integrity check that is
 * ignored is not an integrity check. It also fooled the verifier, not just the
 * author: during the real transfer run this exact difference read as a
 * tampering signal until the bytes were inspected.
 *
 * So for artifacts whose logical identity is their CONTENT -- the adoption
 * protocol is the only one today -- the digest is taken over one canonical
 * representation:
 *
 *   - UTF-8, with any byte-order mark removed;
 *   - LF line endings (CRLF and lone CR both become LF);
 *   - exactly one trailing newline.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch evidence. Captured stdout, stored response bodies and
 * sealed run artifacts keep their exact bytes, because for those the bytes ARE
 * the observation -- a trailing space in a subject's output is a fact about the
 * subject, and normalising it away would be destroying evidence to make a
 * comparison convenient.
 *
 * It also is not a whitespace amnesty. Indentation, internal spacing and blank
 * lines are all preserved and all change the digest. Only the three line-ending
 * and terminator rules above are normalised, because those are the ones a
 * checkout, an editor or a filesystem will change without anyone intending it.
 */

import crypto from 'node:crypto';

/**
 * The canonical byte representation of a text artifact.
 *
 * @param {string|Buffer} input
 * @returns {string}
 */
export function canonicalText(input) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);

  // A BOM is an encoding artifact, not content.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // CRLF first, then any surviving lone CR (old-Mac endings).
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Exactly one terminator: neither "file ends without a newline" nor "file
  // gained a blank line at the end" is a change of content.
  text = text.replace(/\n+$/, '') + '\n';

  return text;
}

/**
 * sha256 over the canonical representation.
 *
 * @param {string|Buffer} input
 * @returns {string} hex digest
 */
export function canonicalTextDigest(input) {
  return crypto.createHash('sha256').update(canonicalText(input), 'utf8').digest('hex');
}

/**
 * Do two text artifacts have the same logical identity?
 *
 * Named so the answer reads as what it means at the call site: this is the
 * question "is the installed protocol the one we shipped", not "are these
 * files byte-identical".
 */
export function sameCanonicalText(a, b) {
  return canonicalTextDigest(a) === canonicalTextDigest(b);
}
