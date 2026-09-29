import assert from 'node:assert/strict';

/**
 * Parse the single JSON array emitted by `npm pack --json` after optional prefixed lifecycle output.
 *
 * @param {string} output complete stdout from npm pack
 * @returns {unknown[]} the parsed npm pack result array
 */
export function parseNpmPackOutput(output) {
  assert.equal(typeof output, 'string', 'npm pack output must be text');

  const candidates = [];
  const lineStartPattern = /^[\t ]*\[/gmu;

  for (const match of output.matchAll(lineStartPattern)) {
    const start = match.index + match[0].lastIndexOf('[');
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < output.length; index += 1) {
      const character = output[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }

        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '[') {
        depth += 1;
      } else if (character === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(output.slice(start, index + 1));
            if (
              Array.isArray(value) &&
              value.length > 0 &&
              value.every(
                (entry) =>
                  entry !== null &&
                  typeof entry === 'object' &&
                  typeof entry.filename === 'string' &&
                  entry.filename.length > 0
              )
            ) {
              candidates.push(value);
            }
          } catch {
            // A lifecycle line can begin with `[`. Only complete valid pack-result arrays are candidates.
          }
          break;
        }

        if (depth < 0) break;
      }
    }
  }

  assert.equal(candidates.length, 1, 'npm pack must emit exactly one valid JSON result array');
  return candidates[0];
}
