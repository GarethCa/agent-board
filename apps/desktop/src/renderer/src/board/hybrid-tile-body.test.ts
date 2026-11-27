import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, ExternalSession } from '@agent-board/daemon/protocol';
import { CalmShellTile } from './CalmShellTile';
import { CalmTile } from './CalmTile';
import { clockHands, FrozenChip, FrozenOr } from './FrostMark';
import { HybridTile } from './HybridTile';
import { lastMessageCard } from './tile-parts';
import { galleryAgent, SHELL } from './TileGallery';
import { QUIET_TILE } from './tile-shows';
import { restoreViewSettings } from './view-settings';

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');

const AT = '2026-10-22T12:00:00.000Z';

/** The agent's tile as the board draws it. */
function render(agent: Agent): string {
  return renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: agent.name, harness: agent.harness, agent } } as never));
}

/** Its bottom row's state: its character, its state's word and its time. */
const markOf = (html: string): string => /<span class="hybrid-tile-mark".*?<\/span><\/span>(?=<\/span>|<button)/.exec(html)?.[0] ?? '';

const idle: Agent = { ...galleryAgent('waiting'), lastMessage: '…and that is why the retry never fired.', description: 'Fix the checkout flake' };

describe("an agent tile's body", () => {
  it('stands its character in its bottom row, by its state, even beside a row with a button of its own', () => {
    expect(markOf(render(idle))).toContain('data-testid="tile-character"');
    const untyped = render({ ...idle, untypedPrompt: 'Pick a database' });
    expect(untyped).toContain('tile-untyped');
    expect(markOf(untyped)).toContain('data-testid="tile-character"');
  });

  it("says the board can't follow a session that sent no hooks, with Open and Restart, over its flag, once its task is typed", () => {
    const silent = render({ ...idle, hooksSilent: true, flag: { id: 1, reason: 'Pick a cache', at: AT, to: 'user', via: null } });
    expect(silent).toContain('data-testid="tile-hooks-silent"');
    expect(silent).toContain('No hooks from this session:</strong> the board can&#x27;t follow its turns');
    expect(silent).toContain('data-testid="hooks-silent-open"');
    expect(silent).toContain('data-testid="hooks-silent-restart"');
    // Unpressed, it says what it does; a first press only asks "Restart?" (two-step.test.ts).
    expect(silent).toMatch(/data-testid="hooks-silent-restart"[^>]*>(?:<[^>]+>)*[^<]*Stop and restart</);
    expect(silent).not.toContain('Restart?');
    expect(silent).not.toContain('data-testid="tile-flag"');
    // Its untyped task comes first: a task never typed is what to act on, and hooks off is often why it was never typed.
    const untyped = render({ ...idle, hooksSilent: true, untypedPrompt: 'Pick a database' });
    expect(untyped).toContain('data-testid="tile-untyped"');
    expect(untyped).not.toContain('tile-hooks-silent');
    expect(render(idle)).not.toContain('tile-hooks-silent');
  });

  it("offers no Stop and restart on a session that can't restart in place: a reviewer, or one run in its shell", () => {
    const reviewer = render({ ...idle, hooksSilent: true, reviewOf: 'impl-1' });
    expect(reviewer).toContain('data-testid="tile-hooks-silent"');
    expect(reviewer).toContain('data-testid="hooks-silent-open"');
    expect(reviewer).not.toContain('hooks-silent-restart');
    const inShell = render({ ...idle, hooksSilent: true, shellHarness: 'claude' });
    expect(inShell).not.toContain('hooks-silent-restart');
  });

  it('says what the agent is for under its name, and the last thing it said once its turn is over', () => {
    const html = render({ ...idle, purpose: 'Make the checkout test pass' });
    expect(html).toMatch(/data-testid="tile-about"[^>]*>Make the checkout test pass</);
    expect(html).not.toContain('tile-ask');
    expect(html).toMatch(/data-testid="tile-description"[^>]*><span class="hybrid-tile-text">…and that is why the retry never fired.</);
  });

  it('falls back to its issue’s title, then its task, for what it is for', () => {
    expect(render({ ...idle, purpose: null })).toMatch(/data-testid="tile-about"[^>]*>Workbench light theme and brand assets</);
    expect(render({ ...idle, purpose: null, issue: null })).toMatch(/data-testid="tile-about"[^>]*>Fix the checkout flake</);
    expect(render({ ...idle, purpose: null, issue: null, description: '' })).toMatch(/data-testid="tile-about" data-empty="true"[^>]*>No task yet</);
  });

  it('says its status line over its task', () => {
    const html = render({ ...idle, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: null } });
    expect(html).toContain('>Retry fix in<');
    expect(html).not.toContain('tile-set-by');
  });

  it('marks a line its orchestrator set, and leaves who to its hover card', () => {
    const html = render({ ...idle, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' } });
    expect(html).toContain('Retry fix in');
    expect(html).toContain('data-testid="tile-set-by-mark"');
    expect(html).not.toContain('data-testid="tile-set-by"');
  });

  it('gives its task as a native tooltip only when it has no hover card, so one tooltip shows at a time', () => {
    const description = (html: string) => /<span[^>]*data-testid="tile-description"[^>]*>/.exec(html)![0];
    const status = { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: null };
    // Its branch goes to the hover card, which then leads with its status and task.
    const quiet = render({ ...idle, lastMessage: null, status });
    expect(description(quiet)).not.toContain('title=');
    // Nothing for a hover card: its status and task are the line's tooltip.
    const plain = render({ ...idle, lastMessage: null, status, branch: '', issue: null });
    expect(description(plain)).toContain('Task: Fix the checkout flake"');
  });

  it('still shows a permission prompt, a question and a plan in place of the line', () => {
    const status = { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' };
    const prompt = render({
      ...idle,
      status,
      state: 'needs-permission',
      permissions: [{ id: 'p', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: false, sessionGrant: null, dialog: null, plan: null, questions: null }],
    });
    expect(prompt).toContain('tile-ask');
    expect(prompt).toContain('rm -rf dist');
    expect(prompt).not.toContain('tile-set-by');

    const question = render({ ...idle, status, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], questions: [{ question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] }], answers: [null], card: null } as unknown as Agent['ask'] });
    expect(question).toContain('Postgres or SQLite?');
    expect(question).toContain('tile-ask');
  });

  it('points at a question on its steps card rather than repeating it', () => {
    const html = render({ ...idle, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], questions: [], answers: [], card: 'card-1' } as unknown as Agent['ask'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('>Asking you on a steps card<');
    expect(html).not.toContain('>Postgres or SQLite?');
  });

  it('still shows a pending plan in place of the line', () => {
    const html = render({ ...idle, plan: { title: 'Move the dock', decision: null } as unknown as Agent['plan'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('Waiting for you to decide on its plan: Move the dock');
  });
});

describe('what tile B says at rest', () => {
  const word = (html: string) => /data-testid="tile-state-word">([^<]*)</.exec(html)?.[1];
  const act = (html: string) => /data-testid="tile-act"[^>]*data-kind="([^"]*)"[^>]*>([^<]*)</.exec(html)?.slice(1);

  it('gives its state in a word, with a time only on Needs you and Paused', () => {
    expect(word(render(idle))).toBe('Idle');
    expect(render(idle)).not.toContain('tile-when');
    const asking = render({ ...idle, flag: { id: 1, reason: 'Pick a cache', at: AT, to: 'user', via: null } });
    expect(word(asking)).toBe('Needs you');
    expect(asking).toContain('data-testid="tile-when"');
    expect(word(render(galleryAgent('thinking')))).toBe('Thinking');
    expect(word(render(galleryAgent('failed')))).toBe('Failed');
  });

  it('has one button: Open for Needs you or Failed, Review for Done, Wake for Paused, and none at work', () => {
    expect(act(render({ ...idle, flag: { id: 1, reason: 'Pick a cache', at: AT, to: 'user', via: null } }))).toEqual(['open', 'Open']);
    expect(act(render(galleryAgent('failed')))).toEqual(['open', 'Open']);
    expect(act(render(galleryAgent('done')))).toEqual(['review', 'Review']);
    // Nothing to review: a merged pull request, or none.
    const merged = galleryAgent('done').pullRequests.map((pr) => ({ ...pr, state: 'merged' as const }));
    expect(render({ ...galleryAgent('done'), pullRequests: merged })).not.toContain('data-testid="tile-act"');
    expect(render({ ...galleryAgent('done'), pullRequests: [] })).not.toContain('data-testid="tile-act"');
    expect(render(galleryAgent('hibernated'))).toContain('data-testid="wake"');
    for (const state of ['thinking', 'running'] as const) {
      const html = render(galleryAgent(state));
      expect(html).not.toContain('data-testid="tile-act"');
      expect(html).not.toContain('data-testid="wake"');
    }
  });

  it('says what a done one finished, and lays idle, done and paused tiles flat', () => {
    const done = render(galleryAgent('done'));
    expect(done).toContain('Finished · PR #46 is ready to review');
    expect(done).toContain('data-flat="true"');
    expect(render(galleryAgent('hibernated'))).toContain('Wake starts it where it left off.');
    expect(render(galleryAgent('thinking'))).not.toContain('data-flat');
    expect(render(galleryAgent('failed'))).not.toContain('data-flat');
  });

  it('keeps a rate limit amber: its word is marked as a warning, and only a warning is', () => {
    const limited = render(galleryAgent('rate-limited'));
    expect(word(limited)).toBe('Waiting');
    expect(limited).toMatch(/data-testid="tile-mark"[^>]*data-warn="true"/);
    expect(render(galleryAgent('waiting'))).not.toContain('data-warn');
  });

  it('lays flat only its own shadow, not the halo of the Captain or an orchestrator', () => {
    const flat = /\.hybrid-tile-agent\[data-flat\]([^{]*)\{([^}]*)\}/.exec(css);
    expect(flat?.[2]).toContain('box-shadow: none');
    for (const halo of ['[data-orchestrator]', '[data-master]']) expect(flat?.[1]).toContain(halo);
    expect(css).toMatch(/\.hybrid-tile-mark\[data-warn\] \.hybrid-tile-word \{\s*color: var\(--state-rate-limited-ink\)/);
  });

  it('still lifts a flat tile while it is dragged: the drag rule comes after the flat rule and outranks it', () => {
    const flatAt = css.search(/\.hybrid-tile-agent\[data-flat\]:not\(/);
    const lift = /\.react-flow__node\.dragging \.hybrid-tile-agent\[data-flat\] \{([^}]*)\}/.exec(css);
    expect(lift?.[1]).toContain('box-shadow: var(--shadow-lifted)');
    expect(lift!.index).toBeGreaterThan(flatAt);
  });

  it('leaves its chips, its pill, its bubble and the paused hatching off', () => {
    const html = render(galleryAgent('waiting'));
    expect(html).not.toContain('data-testid="tile-issue"');
    expect(html).not.toContain('ui-pill');
    expect(html).not.toContain('data-character');
    expect(render(galleryAgent('hibernated'))).not.toContain('data-hatch');
  });
});

describe('the parts Settings turns back on', () => {
  afterEach(() => restoreViewSettings({ tileShows: QUIET_TILE }));
  const orchestrated: Agent = { ...idle, trustedByZone: true, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' } };

  it('keeps the quiet tile until one is turned on', () => {
    const html = render(orchestrated);
    expect(html).not.toContain('hybrid-tile-branch');
    expect(html).toContain('data-corner="hover"');
    expect(html).not.toContain('data-testid="tile-set-by"');
    expect(html).not.toContain('data-testid="tile-trusted-by-zone"');
  });

  it('draws each part turned on, on the tile itself', () => {
    restoreViewSettings({ tileShows: { branchAlways: true, cornerAlways: true, setBy: true, trusted: true } });
    const html = render(orchestrated);
    expect(html).toContain('hybrid-tile-branch');
    expect(html).not.toContain('data-corner="hover"');
    expect(html).toContain('data-testid="tile-set-by"');
    expect(html).toContain('data-testid="tile-trusted-by-zone"');
  });

  it('brings back the bubble, the chips, the pill and the hatching, each with its own switch', () => {
    restoreViewSettings({ tileShows: { bubble: true } });
    const bubble = render({ ...galleryAgent('idle'), status: null, lastMessage: 'Something said' });
    expect(bubble).toContain('hybrid-tile-said" data-character');
    expect(bubble).toMatch(/data-testid="tile-description"[^>]*><span class="hybrid-tile-text">A task as the agent was given it/);
    expect(bubble).not.toContain('data-testid="tile-issue"');
    restoreViewSettings({ tileShows: { chips: true } });
    expect(render(galleryAgent('waiting'))).toContain('data-testid="tile-issue"');
    restoreViewSettings({ tileShows: { statePill: true } });
    const pill = render(galleryAgent('idle'));
    expect(pill).toContain('ui-pill');
    expect(pill).not.toContain('tile-state-word');
    restoreViewSettings({ tileShows: { pausedHatch: true } });
    expect(render(galleryAgent('hibernated'))).toContain('data-hatch="true"');
  });
});

describe('the card of its last message', () => {
  it('has the message, with the time its turn ended, while the body says what it does', () => {
    expect(lastMessageCard({ ...idle, finishedAt: AT })).toEqual({ text: idle.lastMessage, label: expect.stringMatching(/^Last message · \d/) });
    expect(lastMessageCard({ ...idle, finishedAt: null })).toEqual({ text: idle.lastMessage, label: 'Last message' });
  });

  it('is withheld while an ask or a notice takes the body, and with no message', () => {
    expect(lastMessageCard({ ...idle, ask: { question: 'Postgres?', options: [] } as unknown as Agent['ask'] })).toBeUndefined();
    expect(lastMessageCard({ ...idle, notice: 'Its process crashed.' })).toBeUndefined();
    expect(lastMessageCard({ ...idle, lastMessage: null })).toBeUndefined();
  });
});

describe("a tile's head gives its name the room its buttons leave", () => {
  afterEach(() => restoreViewSettings({ tileShows: QUIET_TILE }));

  /** The labels of the buttons in a tile's corner: the one laid over its head, or the calm tile's controls. */
  const corner = (html: string): string[] => {
    const from = html.search(/class="hybrid-tile-corner"|data-testid="tile-controls"/);
    const head = html.slice(from, html.indexOf('</div>', from));
    return [...head.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]!);
  };
  const calm = (agent: Agent): string => renderToStaticMarkup(createElement(CalmTile, { id: 't1', agent } as never));
  const shellTile = (simplified: boolean): string =>
    simplified
      ? renderToStaticMarkup(createElement(CalmShellTile, { id: 's1', shell: SHELL, selected: false }))
      : renderToStaticMarkup(createElement(HybridTile, { id: 's1', tile: { label: SHELL.name, shell: SHELL } } as never));
  const external = (): string =>
    renderToStaticMarkup(
      createElement(HybridTile, {
        id: 'e1',
        tile: {
          label: 'Outside',
          harness: 'claude',
          external: {
            id: 'claude:x',
            harness: 'claude',
            sessionId: 'x',
            zoneId: null,
            position: null,
            name: 'Outside',
            cwd: '/tmp/x',
            worktree: null,
            branch: 'main',
            state: 'idle',
            subagents: [],
            description: '',
            status: null,
          } as unknown as ExternalSession,
        },
      } as never),
    );

  it('is the same two buttons, Expand and ⋯, on every tile, shown only on hover', () => {
    const agents = (['waiting', 'idle', 'stopped-by-restart', 'done', 'hibernated'] as const).map((state) => galleryAgent(state));
    for (const html of [...agents.map(render), ...agents.map(calm), shellTile(false), shellTile(true), external()]) {
      expect(corner(html)).toEqual(['Expand', 'More']);
      expect(html).toContain('data-corner="hover"');
    }
  });

  it('has no Close, Pop out, Restart, Resume, Watches or pencil in any corner: they are in ⋯', () => {
    const tiles = [render(galleryAgent('stopped-by-restart')), calm(galleryAgent('waiting')), shellTile(false), shellTile(true), external()];
    const gone = ['Close agent', 'Pop out', 'Restart', 'Resume', 'Watches', 'Rename', 'Fold to a chip', 'Resume in agent-board'];
    for (const html of tiles) for (const label of gone) expect(corner(html)).not.toContain(label);
  });

  it('keeps the pencil beside the name when Settings shows the corner always, as it takes its own room', () => {
    restoreViewSettings({ tileShows: { cornerAlways: true } });
    const html = render(idle);
    expect(corner(html)).toEqual(['Expand', 'More']);
    expect(html).toContain('aria-label="Rename"');
    for (const each of [html, shellTile(false), external()]) expect(each).not.toContain('data-corner="hover"');
    expect(shellTile(false)).toContain('aria-label="Rename"');
  });

  it('makes each corner button a 24px target', () => {
    expect(css).toMatch(/\.hybrid-tile-actions \.ui-icon-button\[data-size='xs'\] \{\s*width: var\(--space-6\);\s*height: var\(--space-6\);/);
    expect(css).toMatch(/\.calm-tile-controls \.ui-icon-button\[data-size='xs'\] \{\s*width: var\(--space-6\);\s*height: var\(--space-6\);/);
  });

  it('sets no text on a tile under 11px', () => {
    expect(css).toMatch(/\.hybrid-tile:not\(\.glance-tile\) \{\s*--font-size-2xs: var\(--font-size-badge\);/);
  });
});

describe('a paused tile is frosted', () => {
  const calm = (agent: Agent): string => renderToStaticMarkup(createElement(CalmTile, { id: 't1', agent } as never));
  const rootClass = (html: string): string => /^<div class="([^"]*)"/.exec(html)?.[1] ?? '';

  it('carries the frosted class and a snowflake in its head, in Classic and Simplified, only while it is asleep: paused or stopped by a restart', () => {
    for (const draw of [render, calm]) {
      for (const state of ['hibernated', 'stopped-by-restart'] as const) {
        const asleep = draw(galleryAgent(state));
        expect(rootClass(asleep).split(' ')).toContain('tile-frosted');
        expect(asleep).toMatch(/class="hybrid-tile-head[^"]*">.*data-testid="tile-frost-mark"/);
      }
      // Woken, the frost is gone at once: it follows the agent's state and nothing else.
      for (const state of ['idle', 'waiting', 'rate-limited'] as const) {
        const html = draw(galleryAgent(state));
        expect(rootClass(html).split(' ')).not.toContain('tile-frosted');
        expect(html).not.toContain('tile-frost-mark');
      }
    }
  });

  it('washes the tile in its own cool colour, under its buttons, with no motion', () => {
    const wash = /\.hybrid-tile\.tile-frosted::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(wash).toContain('pointer-events: none');
    expect(wash).toContain('var(--frost)');
    expect(wash).not.toMatch(/animation|transition/);
  });

  // An expanded tile renders nothing until its view settings load, so its root and head are read from its source.
  it('frosts an expanded tile too, its terminal and chat included, which stay usable', () => {
    const source = readFileSync(join(import.meta.dirname, 'ExpandedTile.tsx'), 'utf8');
    expect(source).toContain("className={agent ? frostedClasses('expanded-tile', agent, shows) : 'expanded-tile'}");
    expect(source).toContain('<FrostMark agent={agent} />');
    const body = /\.expanded-tile\.tile-frosted \.expanded-tile-body::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toContain('pointer-events: none');
    expect(body).toContain('var(--frost)');
    expect(body).not.toMatch(/animation|transition/);
  });

  it("keeps its mark and watermark from a screen reader, as the tile's status and line say why already", () => {
    const html = render(galleryAgent('hibernated'));
    expect(html).toMatch(/<span class="tile-frost-mark" data-testid="tile-frost-mark" data-kind="paused" aria-hidden="true"/);
    expect(html).toMatch(/<span class="tile-frost-watermark" data-testid="tile-frost-watermark" data-kind="paused" aria-hidden="true"/);
  });

  it('gives a scheduled, a done and an exited agent a frost of its own, with its mark and watermark, in Classic and Simplified', () => {
    const ENDED = '2026-10-23T18:02:00Z';
    const scheduled = galleryAgent('scheduled');
    const kinds: [string, Agent][] = [
      ['scheduled', scheduled],
      ['done', { ...galleryAgent('done'), endedAt: ENDED, schedule: null, pullRequests: [] }],
      ['exited', { ...galleryAgent('failed'), endedAt: ENDED, exitCode: 1, schedule: null }],
      ['exited', { ...galleryAgent('failed'), endedAt: ENDED, exitCode: 0, schedule: null }],
    ];
    for (const draw of [render, calm]) {
      for (const [kind, agent] of kinds) {
        const html = draw(agent);
        expect(rootClass(html).split(' ')).toEqual(expect.arrayContaining(['tile-frosted', `tile-frost-${kind}`]));
        expect(html).toContain(`data-testid="tile-frost-mark" data-kind="${kind}"`);
        expect(html).toContain(`data-testid="tile-frost-watermark" data-kind="${kind}"`);
      }
    }
  });

  it('says how it is frozen in a chip in its expanded tile and its window, in place of its state', () => {
    const ENDED = '2026-10-23T18:02:00';
    const chip = (agent: Agent) => renderToStaticMarkup(createElement(FrozenChip, { agent }));
    expect(chip({ ...galleryAgent('done'), endedAt: ENDED, schedule: null, pullRequests: [] })).toContain('<b class="tile-frost-chip-word">Done</b><span class="tile-frost-chip-when"> · finished 18:02</span>');
    expect(chip({ ...galleryAgent('failed'), endedAt: ENDED, exitCode: 1, schedule: null })).toMatch(/data-kind="exited">.*Exited<\/b>.* · error 18:02/);
    expect(chip(galleryAgent('scheduled'))).toMatch(/data-kind="scheduled">.*Scheduled<\/b>.* · wakes /);
    expect(chip(galleryAgent('running'))).toBe('');
  });

  it('shows the chip in place of its pill only while it is frozen, and the pill while it is live or needs you', () => {
    const ENDED = '2026-10-23T18:02:00';
    const head = (agent: Agent) => renderToStaticMarkup(createElement(FrozenOr, { agent, children: createElement('i', { className: 'pill' }) }));
    const done = { ...galleryAgent('done'), endedAt: ENDED, schedule: null, pullRequests: [] };
    expect(head(done)).toContain('data-testid="frozen-chip"');
    expect(head(done)).not.toContain('class="pill"');
    expect(head(galleryAgent('running'))).toBe('<i class="pill"></i>');
    const open = { ...done, pullRequests: [{ number: 4, title: 'Fix', url: '', state: 'open' as const, checks: 'passing' as const }] };
    expect(head(open)).toBe('<i class="pill"></i>');
  });

  it('never frosts an ended agent that needs you, so it keeps its needs-you look, in Classic and Simplified', () => {
    const ENDED = '2026-10-23T18:02:00Z';
    const open: Agent = { ...galleryAgent('done'), endedAt: ENDED, schedule: null, pullRequests: [{ number: 4, title: 'Fix', url: '', state: 'open', checks: 'passing' }] };
    const flagged: Agent = { ...galleryAgent('failed'), endedAt: ENDED, exitCode: 1, schedule: null, flag: { id: 1, reason: 'Look at this', at: ENDED, to: 'user' } as Agent['flag'] };
    for (const draw of [render, calm]) {
      for (const agent of [open, flagged]) {
        const html = draw(agent);
        expect(rootClass(html).split(' ')).not.toContain('tile-frosted');
        expect(html).not.toContain('tile-frost-mark');
        expect(html).not.toContain('tile-frost-watermark');
      }
    }
  });

  it("sets a scheduled agent's clock hands to its wake time, rounded to the nearest half hour", () => {
    expect(clockHands('2026-10-23T22:30:00')).toEqual({ hour: 315, minute: 180 });
    expect(clockHands('2026-10-23T22:40:00')).toEqual({ hour: 315, minute: 180 });
    expect(clockHands('2026-10-23T22:50:00')).toEqual({ hour: 330, minute: 0 });
    expect(clockHands('2026-10-23T09:00:00')).toEqual({ hour: 270, minute: 0 });
    expect(clockHands(null)).toEqual({ hour: 300, minute: 60 });
    expect(clockHands('not a time')).toEqual({ hour: 300, minute: 60 });
  });

  it('draws the watermark under the text, clipped by the tile, faint and still', () => {
    const mark = /\.tile-frost-watermark \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(mark).toContain('z-index: -1');
    expect(mark).toContain('overflow: hidden');
    expect(mark).toContain('var(--frost-watermark-opacity)');
    expect(mark).toContain('pointer-events: none');
    expect(mark).not.toMatch(/animation|transition|outline/);
  });
});
