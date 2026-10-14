/** The suffix the daemon gives a reviewer's name (`reviewerName` in reviews.ts): " · review r1". */
const REVIEWER_SUFFIX = /^(.*\S) · review (r\d+)$/;

/**
 * A reviewer tile's name split for display: its implementer's name, and "Review · r1" as a subtitle, so the
 * suffix never pushes the name out of the tile. A name without the suffix (renamed by the user) is whole.
 */
export function splitReviewerName(name: string): { name: string; subtitle?: string } {
  const match = REVIEWER_SUFFIX.exec(name);
  return match === null ? { name } : { name: match[1]!, subtitle: `Review · ${match[2]!}` };
}
