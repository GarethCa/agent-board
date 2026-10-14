/** Joins the class names that are set; undefined when none is, so no empty `class` attribute is written. */
export function cx(...names: (string | false | null | undefined)[]): string | undefined {
  return names.filter(Boolean).join(' ') || undefined;
}
