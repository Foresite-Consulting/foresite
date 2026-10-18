/** Join class names, skipping falsy values. Small enough that a dependency is not worth it. */
export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
