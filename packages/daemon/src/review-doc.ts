// A review doc: the markdown a reviewer agent leaves as its final message, in the format its prompt asks for.
// Read by the daemon (a merge waits for no open blockers) and the app's review viewer, which share the rules below for
// when a round may start or approve a merge.
import type { Agent, ReviewRound } from './protocol.ts';

export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What a reviewer says of the work: approve it, or ask for changes. Null when its doc doesn't say. */
export type ReviewVerdict = 'approve' | 'changes-requested';

/** Where a finding is: a path relative to the worktree, and a line. */
export interface FindingLocation {
  path: string;
  line: number;
}

export interface ReviewFinding {
  severity: Severity;
  title: string;
  /** What else it says, on one line; empty when nothing. */
  detail: string;
  location: FindingLocation | null;
  /** Struck through: a later round says it was fixed. */
  resolved: boolean;
}

export interface ReviewDoc {
  /** Its first `#` heading. */
  title: string | null;
  verdict: ReviewVerdict | null;
  /** In the doc's order. None for a doc not in the format, which shows as plain markdown. */
  findings: ReviewFinding[];
}

const TITLE = /^#\s+(.+?)\s*$/;
const VERDICT = /^\W*verdict\W*:\W*(.+)$/i;
const SEVERITY_HEADING = /^#{2,4}\s+\**(blocker|major|minor)/i;
const OTHER_HEADING = /^#{1,6}\s/;
const BULLET = /^[-*+]\s+(.*)$/;
/** A `path/to/file.ext:line`, in backticks or not. */
const LOCATION = /`?((?:[\w.@-]+\/)*[\w.@-]+\.\w+):(\d+)`?/;
const BOLD = /\*\*(.+?)\*\*/;
/** A finding struck through from its start: its title, or the whole of it. */
const STRUCK = /^~~(.+?)~~/;
/** What a `Verdict:` line may say, and nothing else: "I don't approve" or "Approve with changes" say neither. */
const VERDICTS: Record<string, ReviewVerdict> = {
  approve: 'approve',
  approved: 'approve',
  'changes requested': 'changes-requested',
  'request changes': 'changes-requested',
};

/**
 * Reads a review doc: its title, its `Verdict:` line, and under `## Blocker`, `## Major` and `## Minor` (plural or
 * with more words, at any heading depth from 2) one finding per bullet: its **bold** title (else the bullet's text),
 * the first `path:line` in it, and the rest as its detail, indented continuation lines included. A finding struck
 * through (`~~`) from its start is resolved. The verdict is only `Approve` or `Changes requested`; anything else is null,
 * which approves nothing.
 */
export function parseReviewDoc(markdown: string): ReviewDoc {
  let title: string | null = null;
  let verdict: ReviewVerdict | null = null;
  const findings: ReviewFinding[] = [];
  let severity: Severity | undefined;
  let bullets: string[] = [];
  const flush = () => {
    if (severity !== undefined) for (const bullet of bullets) findings.push(finding(severity, bullet));
    bullets = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = SEVERITY_HEADING.exec(line);
    if (heading) {
      flush();
      severity = heading[1]!.toLowerCase() as Severity;
      continue;
    }
    if (OTHER_HEADING.test(line)) {
      flush();
      severity = undefined;
      if (title === null && TITLE.test(line)) title = TITLE.exec(line)![1]!;
      continue;
    }
    const said: RegExpExecArray | null = verdict === null ? VERDICT.exec(line) : null;
    if (said) {
      verdict = VERDICTS[said[1]!.replace(/[*_`]/g, '').trim().replace(/\.$/, '').toLowerCase()] ?? null;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) bullets.push(bullet[1]!);
    else if (line !== '' && bullets.length > 0 && /^\s/.test(raw)) bullets[bullets.length - 1] += ` ${line}`;
  }
  flush();
  return { title, verdict, findings };
}

function finding(severity: Severity, text: string): ReviewFinding {
  const struck = STRUCK.exec(text);
  const resolved = struck !== null;
  let rest = struck ? text.replace(struck[0], struck[1]!) : text;
  const located = LOCATION.exec(rest);
  const location = located ? { path: located[1]!, line: Number(located[2]) } : null;
  if (located) rest = rest.replace(located[0], '').replace(/\(\s*\)/, '');
  const bold = BOLD.exec(rest);
  let title: string;
  if (bold) {
    title = bold[1]!.trim();
    rest = rest.replace(bold[0], '');
  } else {
    title = rest.trim().replace(/[\s:—–-]+$/, '');
    rest = '';
  }
  const detail = rest.replace(/^[\s:—–-]+/, '').replace(/\s+/g, ' ').trim();
  return { severity, title, detail, location, resolved };
}

/** How many findings of each severity are still open. */
export function openFindings(doc: ReviewDoc): Record<Severity, number> {
  const open = { blocker: 0, major: 0, minor: 0 };
  for (const finding of doc.findings) if (!finding.resolved) open[finding.severity] += 1;
  return open;
}

export interface ReviewPromptOptions {
  round: number;
  /** The implementer's name, and the branch whose work is reviewed. */
  implementer: string;
  branch: string;
  /** What its branch is compared with: the branch it left. */
  base: string;
  /** The last round's doc, for a later round. */
  previous?: string;
}

/** What a reviewer agent is started with: review the branch's diff, change nothing, and reply with the doc only. */
export function reviewPrompt({ round, implementer, branch, base, previous }: ReviewPromptOptions): string {
  return [
    `You are the reviewer for round ${round} of the work of ${implementer}, on branch \`${branch}\`, checked out here.`,
    `Review its changes since \`${base}\`, where it started (\`git diff ${base}...HEAD\`): hunt for bugs, missing tests, style that doesn't match the code around it, and repetition. Read the code around the diff and run the tests if you need to. Do not change any files.`,
    ...(previous === undefined
      ? []
      : [`The last round's review asked for the changes below. Strike through the title of each finding that is now fixed (\`- ~~**<finding>**~~ …\`), and keep the ones that aren't.\n\n${previous}`]),
    [
      'Reply with only the review, in this markdown:',
      '',
      '# <one-line title>',
      'Verdict: <Approve, or Changes requested>',
      '',
      '## Blocker',
      '- **<finding>** `path/to/file.ts:88`: <why it matters, and the fix>',
      '',
      '## Major',
      '',
      '## Minor',
      '',
      'Approve only when no blocker is left.',
    ].join('\n'),
  ].join('\n\n');
}

/** "1 blocker", "2 rounds". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Why the implementer can't start another review round now, or undefined if it can: one round at a time, and at most
 * its cap of rounds that left a review (a failed one doesn't count).
 */
export function startBlocked(implementer: Pick<Agent, 'reviewCap'>, rounds: readonly ReviewRound[]): string | undefined {
  const open = rounds.find((round) => round.status === 'reviewing');
  if (open !== undefined) return `Round ${open.round} is still under review.`;
  const reviewed = rounds.filter((round) => round.status === 'ready').length;
  if (reviewed >= implementer.reviewCap) return `All ${count(implementer.reviewCap, 'review round')} used: raise the cap for another.`;
  return undefined;
}

/**
 * Why `round`, one of the implementer's `rounds`, can't approve a merge of its open pull request now, or undefined if it
 * can: only the latest round, once it approves with no blocker open, and while the pull request's checks aren't pending
 * or failing.
 */
export function mergeBlocked(
  implementer: Pick<Agent, 'name' | 'pullRequests'>,
  rounds: readonly ReviewRound[],
  round: ReviewRound,
): string | undefined {
  if (rounds.at(-1)?.id !== round.id) return 'Only the latest round can approve a merge.';
  if (round.doc === null) return `Round ${round.round} has no review yet.`;
  const doc = parseReviewDoc(round.doc);
  const blockers = openFindings(doc).blocker;
  if (blockers > 0) return `${count(blockers, 'blocker')} still open.`;
  if (doc.verdict !== 'approve') return `Round ${round.round} doesn't approve the work.`;
  const pr = implementer.pullRequests.find((known) => known.state === 'open');
  if (pr === undefined) return `${implementer.name} has no open pull request.`;
  if (pr.checks === 'pending' || pr.checks === 'failing') return `#${pr.number}'s checks are ${pr.checks}.`;
  return undefined;
}
