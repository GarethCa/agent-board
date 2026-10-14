/** Whether a parsed JSON value is an object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
