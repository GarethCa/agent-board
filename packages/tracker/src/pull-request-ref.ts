// Names a GitHub pull request. No Node imports, so clients (the app's renderer) can use it too.

/** A pull request by its repo (`owner/repo`) and number: what a PR tab is kept by. */
export interface PullRequestRef {
  repo: string;
  number: number;
}

/**
 * A GitHub `owner/repo`, as a pattern to build on: an owner of letters, digits and dashes, and a repo name of those, `.`
 * and `_`, but never `.` or `..` alone, which a URL path would read as a step.
 */
const REPO = String.raw`[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?(?:[/?#]|$))[\w.-]+`;

/** Whether `repo` is a GitHub `owner/repo`: nothing gh could read as a flag, or a path of its own. */
export const isGitHubRepo = (repo: string): boolean => new RegExp(`^${REPO}$`).test(repo);

/** The pull request a GitHub pull request URL names, if it names one. */
export function pullRequestOfUrl(url: string): PullRequestRef | undefined {
  const match = new RegExp(String.raw`^https:\/\/github\.com\/(${REPO})\/pull\/(\d+)(?:[/?#]|$)`).exec(url);
  return match === null ? undefined : { repo: match[1]!, number: Number(match[2]) };
}
