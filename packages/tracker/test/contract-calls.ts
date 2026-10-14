/** The writes the tracker contract makes, shared with the fixture recorder so recorded requests match. */
export const CONTRACT_LINK = { url: 'https://github.com/acme/app/pull/7', title: 'PR #7' };
export const CONTRACT_COMMENT = 'Started by agent-board';
/** Appended to a known issue's ID, or a scope's key, to make one that doesn't exist. */
export const MISSING_ISSUE_SUFFIX = '999';
/** A valid version 4 UUID no project has: Linear rejects the all-zero UUID as an invalid argument. */
export const MISSING_PROJECT_ID = '00000000-0000-4000-8000-0000000000ff';
