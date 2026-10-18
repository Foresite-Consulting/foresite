/**
 * Checks on a parsed JSON body before anything else touches it (review F4).
 *
 * A 64 KB body can still nest tens of thousands of levels deep, which makes
 * recursive code (`JSON.stringify`, `structuredClone`, schema validation)
 * throw a RangeError, and PostgreSQL's jsonb refuses some strings JSON allows
 * (`\u0000`, unpaired surrogates). Either would surface as a 5xx from the
 * store. Refusing them here turns attacker-controlled input into a 400.
 *
 * The walk is iterative, so the check itself cannot overflow the stack.
 */

export const MAX_JSON_DEPTH = 32;

export type JsonSafetyProblem = 'too_deep' | 'unsupported_string';

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function badString(value: string): boolean {
  return value.includes('\u0000') || UNPAIRED_SURROGATE.test(value);
}

/**
 * `null` when the value is safe to store; otherwise why not. Depth counts
 * containers: `1`, `[]` and `{}` are depth 0, 1 and 1.
 */
export function checkJsonSafety(
  value: unknown,
  maxDepth: number = MAX_JSON_DEPTH,
): JsonSafetyProblem | null {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value: current, depth } = next;
    if (typeof current === 'string') {
      if (badString(current)) return 'unsupported_string';
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    const childDepth = depth + 1;
    if (childDepth > maxDepth) return 'too_deep';
    if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: childDepth });
    } else {
      for (const [key, item] of Object.entries(current)) {
        if (badString(key)) return 'unsupported_string';
        stack.push({ value: item, depth: childDepth });
      }
    }
  }
  return null;
}
