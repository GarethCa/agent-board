import { describe, expect, it } from 'vitest';
import type { Agent, PullRequest, ReviewRound } from '../src/protocol.ts';
import { mergeBlocked, openFindings, parseReviewDoc, reviewPrompt, startBlocked } from '../src/review-doc.ts';

const ROUND_ONE = `# movable-sessions · PR #214

Verdict: Changes requested

## Blocker
- **Worktree moves while the PTY still holds its cwd** \`daemon/src/sessions/move.ts:88\` — The shell keeps the old path open; the next command fails.

## Major
- **Migration 0009 has no down step** \`daemon/migrations/0009_zone_id.sql:1\`
- **Drop hit-test ignores board zoom** (desktop/src/board/useZoneDrop.ts:41): it uses screen pixels.
  It should use flow coordinates.

## Minor
- ~~**e2e waits with sleep(500)**~~ \`e2e/move-session.spec.ts:57\`
- Rename the helper
`;

describe('parseReviewDoc', () => {
  it('reads the title, verdict and findings by severity, with their file:line', () => {
    const doc = parseReviewDoc(ROUND_ONE);

    expect(doc.title).toBe('movable-sessions · PR #214');
    expect(doc.verdict).toBe('changes-requested');
    expect(doc.findings).toEqual([
      {
        severity: 'blocker',
        title: 'Worktree moves while the PTY still holds its cwd',
        detail: 'The shell keeps the old path open; the next command fails.',
        location: { path: 'daemon/src/sessions/move.ts', line: 88 },
        resolved: false,
      },
      {
        severity: 'major',
        title: 'Migration 0009 has no down step',
        detail: '',
        location: { path: 'daemon/migrations/0009_zone_id.sql', line: 1 },
        resolved: false,
      },
      {
        severity: 'major',
        title: 'Drop hit-test ignores board zoom',
        detail: 'it uses screen pixels. It should use flow coordinates.',
        location: { path: 'desktop/src/board/useZoneDrop.ts', line: 41 },
        resolved: false,
      },
      {
        severity: 'minor',
        title: 'e2e waits with sleep(500)',
        detail: '',
        location: { path: 'e2e/move-session.spec.ts', line: 57 },
        resolved: true,
      },
      { severity: 'minor', title: 'Rename the helper', detail: '', location: null, resolved: false },
    ]);
    expect(openFindings(doc)).toEqual({ blocker: 1, major: 2, minor: 1 });
  });

  it('reads an approval, plural and decorated headings, and a bold verdict', () => {
    const doc = parseReviewDoc('**Verdict:** Approve\n\n### Blockers (none)\n\n### Minor issues\n* **Rename it** `a.ts:3`');

    expect(doc.title).toBeNull();
    expect(doc.verdict).toBe('approve');
    expect(doc.findings).toEqual([
      { severity: 'minor', title: 'Rename it', detail: '', location: { path: 'a.ts', line: 3 }, resolved: false },
    ]);
  });

  it.each(["Verdict: I don't approve", 'Verdict: Approve with changes', 'Verdict: Approve | Changes requested', 'Verdict: not approved'])(
    'reads no verdict from %j, which approves nothing',
    (line) => {
      expect(parseReviewDoc(line).verdict).toBeNull();
    },
  );

  it.each(['Verdict: approve.', '**Verdict:** *Approved*', 'Verdict: Changes requested', 'Verdict: request changes'])('reads a verdict from %j', (line) => {
    expect(parseReviewDoc(line).verdict).not.toBeNull();
  });

  it('counts a finding resolved only when it is struck through from its start', () => {
    const doc = parseReviewDoc('## Blocker\n- **The renderer mangles `~~x~~`** `a.ts:1`\n- ~~The whole of it~~\n');

    expect(doc.findings.map(({ title, detail, resolved }) => ({ title, detail, resolved }))).toEqual([
      { title: 'The renderer mangles `~~x~~`', detail: '', resolved: false },
      { title: 'The whole of it', detail: '', resolved: true },
    ]);
    expect(openFindings(doc).blocker).toBe(1);
  });

  it('finds nothing in a doc not in the format, which shows as plain markdown', () => {
    const doc = parseReviewDoc('Looks fine to me.\n\n- one thing');

    expect(doc).toEqual({ title: null, verdict: null, findings: [] });
  });
});

describe('reviewPrompt', () => {
  it("asks for the review of the branch since its base, in the doc's format, changing nothing", () => {
    const prompt = reviewPrompt({ round: 1, implementer: 'movable-sessions', branch: 'acme-58-movable', base: 'main' });

    expect(prompt).toContain('round 1');
    expect(prompt).toContain('`git diff main...HEAD`');
    expect(prompt).toContain('acme-58-movable');
    expect(prompt).toContain('Verdict: <Approve, or Changes requested>');
    // Echoed back as it is, the template line approves nothing.
    expect(parseReviewDoc(prompt).verdict).toBeNull();
    expect(prompt).toMatch(/do not change/i);
    expect(prompt).not.toContain('last round');
  });

  it('gives a later round the last review, to say what it resolved', () => {
    const prompt = reviewPrompt({ round: 2, implementer: 'a', branch: 'b', base: 'main', previous: '# Old\nVerdict: Changes requested' });

    expect(prompt).toContain('round 2');
    expect(prompt).toContain('last round');
    expect(prompt).toContain('# Old\nVerdict: Changes requested');
  });
});

const round = (fields: Partial<ReviewRound> & Pick<ReviewRound, 'id' | 'round'>): ReviewRound => ({
  implementer: 'coder',
  reviewer: null,
  head: null,
  status: 'ready',
  doc: '# Done\n\nVerdict: Approve\n\n## Blocker\n- ~~**Fixed**~~',
  failedBecause: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  finishedAt: '2026-10-11T10:05:00.000Z',
  sentAt: null,
  dismissedAt: null,
  ...fields,
});

const CHANGES = '# R1\n\nVerdict: Changes requested\n\n## Blocker\n- **Broken** `a.ts:1`';
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({ number: 41, title: 'Work', url: '', state: 'open', checks: 'passing', ...fields });
const agent = (fields: Partial<Agent> = {}) => ({ sessionId: 'coder', name: 'Coder', reviewCap: 3, pullRequests: [pr()], ...fields }) as Agent;

describe('startBlocked', () => {
  it('says why another round can not start: one under review, or the cap of reviewed rounds reached', () => {
    expect(startBlocked(agent(), [])).toBeUndefined();
    expect(startBlocked(agent(), [round({ id: 'a', round: 1, status: 'reviewing', doc: null })])).toBe('Round 1 is still under review.');
    expect(startBlocked(agent({ reviewCap: 1 }), [round({ id: 'a', round: 1 })])).toBe('All 1 review round used: raise the cap for another.');
  });

  it("doesn't count a failed round against the cap", () => {
    expect(startBlocked(agent({ reviewCap: 1 }), [round({ id: 'a', round: 1, status: 'failed', doc: null })])).toBeUndefined();
  });
});

describe('mergeBlocked', () => {
  const approved = round({ id: 'b', round: 2 });

  it('allows a merge from the latest round once it approves with no open blocker, and the open PR is green', () => {
    expect(mergeBlocked(agent(), [round({ id: 'a', round: 1, doc: CHANGES }), approved], approved)).toBeUndefined();
    expect(mergeBlocked(agent({ pullRequests: [pr({ checks: 'none' })] }), [approved], approved)).toBeUndefined();
  });

  it('says why not otherwise', () => {
    const first = round({ id: 'a', round: 1, doc: CHANGES });
    expect(mergeBlocked(agent(), [first], first)).toBe('1 blocker still open.');
    expect(mergeBlocked(agent(), [first, approved], first)).toBe('Only the latest round can approve a merge.');
    const pending = round({ id: 'c', round: 1, status: 'reviewing', doc: null });
    expect(mergeBlocked(agent(), [pending], pending)).toBe('Round 1 has no review yet.');
    const noVerdict = round({ id: 'c', round: 1, doc: 'Looks fine.' });
    expect(mergeBlocked(agent(), [noVerdict], noVerdict)).toBe("Round 1 doesn't approve the work.");
    expect(mergeBlocked(agent({ pullRequests: [] }), [approved], approved)).toBe('Coder has no open pull request.');
    expect(mergeBlocked(agent({ pullRequests: [pr({ checks: 'failing' })] }), [approved], approved)).toBe("#41's checks are failing.");
  });
});
