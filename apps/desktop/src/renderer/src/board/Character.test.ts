import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FACES, AGENT_PROPS } from '@agent-board/daemon/character';
import type { Agent, NeedsYouShows, Subagent } from '@agent-board/daemon/protocol';
import { CalmTile } from './CalmTile';
import { Captain, CAPTAIN_SIZES, Character } from './Character';
import { CHARACTER_POSES } from './character-figures';
import { CharacterGallery, CharacterLooksGallery, CharacterStylesGallery } from './CharacterGallery';
import { HybridTile } from './HybridTile';
import { MAX_PERCHED } from './perch';
import type { TileData } from './tile';

/** What the needs-you inbox lists, as the window's setting says: a tile reads it to know whether it needs the user. */
const setting = vi.hoisted(() => ({ shows: 'explicit' as NeedsYouShows }));
vi.mock('../needs-you-setting', () => ({ useNeedsYouShows: () => setting.shows }));
afterEach(() => {
  setting.shows = 'explicit';
});

interface Drawn {
  attributes: Record<string, string>;
  /** The markup inside it. */
  drawing: string;
}

/** The characters in rendered markup, in order. Characters are `<svg>`s with no `<svg>` inside them. */
function charactersIn(html: string): Drawn[] {
  return [...html.matchAll(/<svg([^>]*data-testid="character"[^>]*)>(.*?)<\/svg>/g)].map(([, attributes, drawing]) => ({
    attributes: Object.fromEntries([...attributes!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, value!])),
    drawing: drawing!,
  }));
}

const pick = (characters: Drawn[], ...names: string[]) => characters.map((c) => names.map((name) => c.attributes[name]));

describe('the character gallery', () => {
  const gallery = charactersIn(renderToStaticMarkup(createElement(CharacterGallery)));

  it('shows the poses a subagent can strike, and its page shows them all', () => {
    expect(CHARACTER_POSES).toEqual([
      'running',
      'thinking',
      'waiting',
      'needs-permission',
      'idle',
      'rate-limited',
      'failed',
      'done',
      'handing-off',
      'on-command',
      'starting',
      'reading',
      'writing',
      'testing',
      'waiting-on-review',
      'hibernated',
      'stopped-by-restart',
    ]);
    expect(new Set(pick(gallery, 'data-pose').flat())).toEqual(new Set(CHARACTER_POSES.slice(0, 10)));
    const page = charactersIn(renderToStaticMarkup(createElement(CharacterStylesGallery)));
    expect(new Set(pick(page, 'data-pose').flat())).toEqual(new Set(CHARACTER_POSES));
    expect(page).toHaveLength(CHARACTER_POSES.length * 6);
  });

  it('draws each pose with a bean body for Claude and a block body for Codex', () => {
    for (const pose of CHARACTER_POSES.slice(0, 10)) {
      const posed = gallery.filter((c) => c.attributes['data-pose'] === pose);
      expect(pick(posed, 'data-harness', 'data-body')).toEqual([
        ['claude', 'bean'],
        ['codex', 'block'],
      ]);
    }
  });

  it('gives each pose its own drawing, but for the two that both need the user, in every style', () => {
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      const drawings = CHARACTER_POSES.filter((pose) => pose !== 'needs-permission').map((pose) => charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose, style })))[0]!.drawing);
      expect(new Set(drawings).size, style).toBe(CHARACTER_POSES.length - 1);
    }
  });

  it('draws every face and prop an agent may give its pose, each its own drawing, in every style, on the page with the poses', () => {
    const page = charactersIn(renderToStaticMarkup(createElement(CharacterLooksGallery)));
    expect(page).toHaveLength((AGENT_FACES.length + AGENT_PROPS.length) * 6);
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      const drawing = (look: { face?: (typeof AGENT_FACES)[number]; prop?: (typeof AGENT_PROPS)[number] }) =>
        charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose: 'reading', style, ...look })))[0]!.drawing;
      const plain = drawing({});
      const faces = AGENT_FACES.map((face) => drawing({ face }));
      expect(new Set([plain, ...faces]).size, `${style} faces`).toBe(AGENT_FACES.length + 1);
      // Reading's own prop is the book: the agent giving it draws the pose as it is.
      const props = AGENT_PROPS.filter((prop) => prop !== 'book').map((prop) => drawing({ prop }));
      expect(new Set([plain, ...props]).size, `${style} props`).toBe(AGENT_PROPS.length);
      expect(drawing({ prop: 'book' }), `${style} book`).toBe(plain);
    }
  });

  it("draws a prop the agent gave in the working colour, while its pose's own keeps the board's colour for it", () => {
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      const drawing = (prop?: 'docclock' | 'magnifier') =>
        charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose: 'waiting-on-review', style, ...(prop === undefined ? {} : { prop }) })))[0]!.drawing;
      expect(drawing(), style).toContain('var(--state-hibernated)');
      expect(drawing('docclock'), style).toBe(drawing());
      expect(drawing('magnifier'), style).toContain('var(--accent)');
      expect(drawing('magnifier'), style).not.toContain('var(--state-');
    }
  });

  it("paints every style's body with one class, so the design picks its colour and the harness never does", () => {
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      for (const harness of ['claude', 'codex'] as const) {
        const { drawing } = charactersIn(renderToStaticMarkup(createElement(Character, { harness, pose: 'testing', style })))[0]!;
        expect(drawing, `${style} ${harness}`).toContain('class="character-body"');
      }
    }
  });

  it('keeps every drawing small, for a board of 40 tiles: each element is one more on every tile', () => {
    const elements = (drawing: string) => (drawing.match(/<(?!\/)/g) ?? []).length;
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      for (const pose of CHARACTER_POSES) {
        const { drawing } = charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose, style })))[0]!;
        expect(elements(drawing), `${style} ${pose}`).toBeLessThanOrEqual(13);
      }
    }
    for (const { attributes, drawing } of charactersIn(renderToStaticMarkup(createElement(CharacterLooksGallery)))) {
      expect(elements(drawing), `${attributes['data-style']} ${attributes['data-face'] ?? attributes['data-prop']}`).toBeLessThanOrEqual(13);
    }
  });

  it('tells the bodies apart by shape in every style, not colour', () => {
    for (const style of ['bean', 'pebble', 'pixel'] as const) {
      const [bean, block] = (['claude', 'codex'] as const).map((harness) => charactersIn(renderToStaticMarkup(createElement(Character, { harness, pose: 'testing', style })))[0]!.drawing);
      expect(bean, style).not.toBe(block);
      expect(paints(bean!).filter((paint) => paint.includes('harness'))).toEqual([]);
      expect(paints(block!).filter((paint) => paint.includes('harness'))).toEqual([]);
    }
  });
});

/** Every paint in rendered markup: each `fill` and `stroke`, as an attribute or in a `style`. */
const paints = (html: string) => [...html.matchAll(/(?:^|[\s;"])(?:fill|stroke)(?:="|:)([^";]+)/g)].map(([, paint]) => paint!.trim());

describe('the palette', () => {
  it("paints each pose in every style only with the figure's tokens and the colour the board gives its state", () => {
    const html = renderToStaticMarkup(createElement(CharacterStylesGallery)) + renderToStaticMarkup(createElement(CharacterLooksGallery));
    expect(new Set(paints(html).filter((paint) => !/^var\(--(figure-(ink|paper|body|eye)|accent|state-[\w-]+)\)$/.test(paint)))).toEqual(new Set(['none']));
  });

  it("paints the Captain only in Claude's orange and the figure's ink, paper and hat: no skin tones", () => {
    const html = renderToStaticMarkup(createElement(Captain, { size: 'avatar' }));
    expect(new Set(paints(html))).toEqual(new Set(['var(--harness-claude)', 'var(--figure-ink)', 'var(--figure-paper)', 'var(--figure-hat)', 'var(--figure-hat-emblem)', 'none']));
  });
});

describe('the Captain', () => {
  it('is drawn at a size for each place it appears, as tall as that place asks and a whole number of pixels wide', () => {
    for (const [size, height] of Object.entries(CAPTAIN_SIZES)) {
      const html = renderToStaticMarkup(createElement(Captain, { size: size as keyof typeof CAPTAIN_SIZES }));
      expect(html).toMatch(new RegExp(`<svg[^>]*data-testid="captain"[^>]*width="\\d+" height="${height}"`));
    }
  });

  it('is named for screen readers', () => {
    expect(renderToStaticMarkup(createElement(Captain, { size: 'toolbar' }))).toMatch(/<svg[^>]*role="img"[^>]*aria-label="The Captain"/);
  });

  it('stands in the gallery at every size under the Simplified design, and is absent from it otherwise', () => {
    const shown = renderToStaticMarkup(createElement(CharacterGallery, { captain: true }));
    expect([...shown.matchAll(/data-testid="captain" data-size="([\w-]+)"/g)].map(([, size]) => size)).toEqual(Object.keys(CAPTAIN_SIZES));
    expect(renderToStaticMarkup(createElement(CharacterGallery))).not.toContain('data-testid="captain"');
  });
});

describe('a character', () => {
  it('stays upright as Pixel when it fails, its alert upright beside it, as wide as any other pose', () => {
    const drawn = (pose: 'failed' | 'idle') => charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose, style: 'pixel' })))[0]!;
    expect(drawn('failed').drawing).not.toContain('rotate');
    expect(drawn('failed').attributes.width).toBe(drawn('idle').attributes.width);
    expect(drawn('failed').drawing).toContain('var(--state-failed)');
  });

  it('stands as tall as asked, but for Pixel, which snaps so it never blurs', () => {
    const drawn = (style: 'bean' | 'pixel', height: number) => charactersIn(renderToStaticMarkup(createElement(Character, { harness: 'claude', pose: 'idle', style, height })))[0]!.attributes;
    expect(drawn('bean', 34)).toMatchObject({ height: '34', width: '30' });
    expect(drawn('pixel', 34)).toMatchObject({ height: '32', width: '40' });
    expect(drawn('pixel', 22)).toMatchObject({ height: '24', width: '30' });
  });

  it('is left out for screen readers on a tile, whose name and status word say what it does', () => {
    const html = renderToStaticMarkup(createElement(Character, { harness: 'claude', pose: 'idle', decorative: true }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('aria-label');
  });

  it('names its subagent and pose for screen readers', () => {
    const [character] = charactersIn(
      renderToStaticMarkup(createElement(Character, { harness: 'claude', pose: 'needs-permission', label: 'Explore' })),
    );
    expect(character!.attributes).toMatchObject({ role: 'img', 'aria-label': 'Explore: needs permission' });
  });
});

describe('subagents on a Hybrid tile', () => {
  const subagent = (id: string, fields: Partial<Subagent> = {}): Subagent => ({
    id,
    type: 'Explore',
    state: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    result: null,
    ...fields,
  });

  function agentOf(subagents: Subagent[], harness: 'claude' | 'codex' = 'claude', fields: Partial<Agent> = {}): Agent {
    return {
      sessionId: 's1',
      zoneId: 'z1',
      repoRoot: '/code/app',
      position: null,
      harness,
      model: null,
      effort: null,
      effortPending: null,
      role: null,
      roleName: null,
      reviews: null,
      name: 'agent',
      description: 'Map the code',
      branch: 'map-the-code',
      ownedBranch: 'map-the-code',
      detached: false,
      worktree: '/tmp/w',
      cwd: '/tmp/w',
      state: 'running',
      notice: null,
      earlierConversations: [],
      hibernated: null,
      muted: false,
      seen: false,
      issue: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      shellSessionId: null,
      shellHarness: null,
      clickableLinks: null,
      subagents,
      commands: [],
      pullRequests: [],
      pushedPullRequests: [],
      records: [],
      recordedPullRequests: [],
      guessedDoc: null,
      page: null,
      lastMessage: null,
      compactingSince: null,
      stateSince: new Date().toISOString(),
      finishedAt: null,
      permissions: [],
      ask: null,
      stepsWait: null,
      plan: null,
      docs: [],
      schedule: null,
      reviewOf: null,
      reviewCap: 3,
      ownsWorktree: true,
      master: false,
      plainFolder: false,
      orchestrate: null,
      spawnedBy: null,
      ledBy: null,
      startup: null,
      hooksSilent: false,
      unsent: null,
      untypedPrompt: null,
      trustFolder: null,
      trustedByZone: false,
      queuedUntilUp: 0,
      messagesWaiting: 0,
      undelivered: [],
      status: null,
      character: null,
      workCategory: null,
      purpose: null,
      workFinishedAt: null,
      flag: null,
      ...fields,
    };
  }

  function tile(subagents: Subagent[], harness: 'claude' | 'codex' = 'claude', fields: Partial<Agent> = {}): string {
    const data: TileData = { label: 'agent', harness, agent: agentOf(subagents, harness, fields) };
    return renderToStaticMarkup(createElement(HybridTile, { id: 'agent:s1', tile: data }));
  }

  it('stands the agent itself at the leading edge of its body, apart from what perches', () => {
    const html = tile([subagent('a')]);
    expect(html).toMatch(/hybrid-tile-said" data-character="bean"><span class="tile-character" data-pose="running"><svg[^>]*data-testid="tile-character"[^>]*width="30" height="34"/);
  });

  it("draws an agent ended into a shell by its pill's state, as any agent ended", () => {
    const done = tile([], 'claude', { shellHarness: 'claude', state: 'done', endedAt: new Date().toISOString(), exitCode: 0 });
    expect(done).toMatch(/data-testid="tile-character" data-pose="done"/);
    const failed = tile([], 'claude', { shellHarness: 'claude', state: 'failed', endedAt: new Date().toISOString(), exitCode: 1 });
    expect(failed).toMatch(/data-testid="tile-character" data-pose="failed"/);
  });

  it("draws the pose the agent set over its work and its finished turn, and the board's needing you over that", () => {
    const character = (pose: NonNullable<Agent['character']>['pose']) => ({ pose, face: null, prop: null, setAt: new Date().toISOString(), setBy: null });
    expect(tile([], 'claude', { character: character('testing') })).toMatch(/data-testid="tile-character" data-pose="testing"/);
    expect(tile([], 'claude', { character: character('running-a-tool') })).toMatch(/data-testid="tile-character" data-pose="running"/);
    expect(tile([], 'claude', { state: 'waiting', character: character('waiting-on-review') })).toMatch(/data-testid="tile-character" data-pose="waiting-on-review"/);
    expect(tile([], 'claude', { state: 'needs-permission', character: character('testing') })).toMatch(/data-testid="tile-character" data-pose="needs-permission"/);
    expect(tile([], 'claude', { state: 'failed', character: character('testing') })).toMatch(/data-testid="tile-character" data-pose="failed"/);
  });

  describe("the board's states over the pose an agent set, on both designs", () => {
    const posed = (pose: NonNullable<Agent['character']>['pose']): Agent['character'] => ({ pose, face: null, prop: null, setAt: new Date().toISOString(), setBy: null });
    const DESIGNS: Record<string, (fields: Partial<Agent>) => string> = {
      Classic: (fields) => tile([], 'claude', fields),
      Simplified: (fields) => renderToStaticMarkup(createElement(CalmTile, { id: 'agent:s1', selected: false, agent: agentOf([], 'claude', fields) })),
    };
    /** The pose a tile's own character strikes. */
    const poseOn = (html: string): string | undefined => /class="tile-character" data-pose="([^"]+)"/.exec(html)?.[1];

    const AT = new Date().toISOString();
    const permission: Agent['permissions'][number] = {
      id: 'p',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf dist' },
      subagent: null,
      requestedAt: AT,
      heldUntil: null,
      asksInTerminal: false,
      sessionGrant: null,
      questions: null,
    };
    const question = { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], freeText: true };
    const ask: Agent['ask'] = { id: 'q', ...question, askedAt: AT, expiresAt: AT, onBoard: false, questions: [question], answers: [null], card: null };
    /** What an agent waits on the user for, by name. */
    const WAITS: Record<string, Partial<Agent>> = {
      'a permission': { state: 'needs-permission', permissions: [permission] },
      'a question': { state: 'waiting', ask },
      'a plan to review': { state: 'waiting', plan: { title: 'Selection strategy', decision: null } as Agent['plan'] },
      'a steps card': { state: 'waiting', stepsWait: { kind: 'steps' } as Agent['stepsWait'] },
      'a flag to the user': { state: 'waiting', flag: { id: 1, reason: 'Which database?', at: AT, to: 'user', via: null } },
    };

    for (const [design, draw] of Object.entries(DESIGNS)) {
      it(`${design}: draws what the agent waits on the user for, seen or not, never the pose it set`, () => {
        for (const [name, wait] of Object.entries(WAITS)) {
          for (const seen of [false, true]) {
            const board = poseOn(draw({ ...wait, seen }));
            expect(board, `${name}, seen ${seen}`).toBeDefined();
            for (const pose of ['testing', 'waiting-on-review'] as const) {
              expect(poseOn(draw({ ...wait, seen, character: posed(pose) })), `${pose} over ${name}, seen ${seen}`).toBe(board);
            }
          }
        }
        expect(poseOn(draw({ ...WAITS['a permission'], character: posed('testing') }))).toBe('needs-permission');
      });

      it(`${design}: draws a finished turn the inbox lists as needing you, and the pose where the tile does not say so`, () => {
        setting.shows = 'turns';
        const turn: Partial<Agent> = { state: 'waiting', character: posed('waiting-on-review') };
        expect(poseOn(draw({ ...turn, seen: false }))).toBe('waiting');
        // A Classic pill drops the needs-you look once the turn is seen. The Simplified status reads no `seen`: it says
        // Needs you until the turn is answered, and its character says so with it.
        expect(poseOn(draw({ ...turn, seen: true }))).toBe(design === 'Classic' ? 'waiting-on-review' : 'waiting');
        setting.shows = 'explicit';
        expect(poseOn(draw({ ...turn, seen: false }))).toBe('waiting-on-review');
      });

      it(`${design}: draws an agent at its prompt with its pull request open as its own status says, the pose under it`, () => {
        const pullRequests: Agent['pullRequests'] = [{ number: 41, title: 'Add the dock', url: '', state: 'open', checks: 'passing' }];
        // The Simplified status reads an open pull request as Needs you ("Changes ready to review"), the board's to
        // draw. Classic's pill rests there, so the agent's waiting on review shows.
        expect(poseOn(draw({ state: 'idle', pullRequests, character: posed('waiting-on-review') }))).toBe(design === 'Classic' ? 'waiting-on-review' : 'waiting');
      });

      it(`${design}: draws a working pose only in a turn, and a resting one at the prompt`, () => {
        expect(poseOn(draw({ state: 'running', character: posed('testing') }))).toBe('testing');
        for (const state of ['idle', 'waiting'] as const) {
          expect(poseOn(draw({ state, character: posed('testing') })), state).toBe(poseOn(draw({ state })));
          expect(poseOn(draw({ state, character: posed('waiting-on-review') })), state).toBe('waiting-on-review');
        }
      });
    }
  });

  it('draws the face and prop the agent gave its pose, and says whose pose it is on hover; the board draws its own over them', () => {
    const character = (setBy: string | null) => ({ pose: 'reading' as const, face: 'puzzled' as const, prop: 'magnifier' as const, setAt: new Date().toISOString(), setBy });
    expect(tile([], 'claude', { character: character(null) })).toMatch(
      /<span class="tile-character" data-pose="reading" title="Reading · set by the agent"><svg[^>]*data-testid="tile-character" data-pose="reading" data-face="puzzled" data-prop="magnifier"/,
    );
    expect(tile([], 'claude', { character: character('lead') })).toContain('title="Reading · set by ◎ lead"');
    // In the agent's word, not the board's: it set running a tool.
    const running = { pose: 'running-a-tool' as const, face: null, prop: null, setAt: new Date().toISOString(), setBy: null };
    expect(tile([], 'claude', { character: running })).toContain('title="Running a tool · set by the agent"');
    const asking = tile([], 'claude', { state: 'needs-permission', character: character(null) });
    expect(asking).toMatch(/<span class="tile-character" data-pose="needs-permission"><svg[^>]*data-testid="tile-character" data-pose="needs-permission" data-harness/);
    // The board's own pose has nothing more to say on hover than its word.
    expect(tile([])).toMatch(/<span class="tile-character" data-pose="running">/);
  });

  it('draws what it hands on and what it times as its own pose, with no second robot over the tile', () => {
    const html = tile([], 'claude', { state: 'on-command' });
    expect(html).toMatch(/data-testid="tile-character" data-pose="on-command"/);
    expect(html).not.toContain('hybrid-tile-handoff');
  });

  it('perches a character for each subagent, in its harness body', () => {
    const html = tile([subagent('a'), subagent('b', { state: 'thinking' })], 'codex');
    expect(pick(charactersIn(html), 'data-pose', 'data-body')).toEqual([
      ['running', 'block'],
      ['thinking', 'block'],
    ]);
    expect(html).not.toContain('data-testid="subagent-overflow"');
  });

  it('stays legible with many subagents: a cap and an overflow count', () => {
    const html = tile(Array.from({ length: MAX_PERCHED + 3 }, (_, i) => subagent(`s${i}`)));
    expect(charactersIn(html)).toHaveLength(MAX_PERCHED);
    expect(html).toMatch(/data-testid="subagent-overflow"[^>]*>\+3</);
  });

  it('shows a finished subagent dropping its result as it leaves', () => {
    const html = tile([subagent('a', { state: 'done', endedAt: new Date().toISOString(), result: 'Found it.' })]);
    expect(pick(charactersIn(html), 'data-pose')).toEqual([['handing-off']]);
    // The perched character wraps the svg: it is the one leaving, and it carries the result.
    expect(html).toMatch(/<[^>]*data-leaving="true"[^>]*title="Explore: Found it\."[^>]*>\s*<svg[^>]*data-testid="character"/);
  });

  it('carries a clock badge with its next run while it has a schedule, and none while it has none (its More menu schedules it)', () => {
    const nextRunAt = new Date(Date.now() + 60 * 60_000);
    const schedule = { clockId: 'clock-1', cron: '0 * * * *', prompt: 'Sweep', enabled: true, nextRunAt: nextRunAt.toISOString(), lastRun: null, hibernates: false };
    const time = `${String(nextRunAt.getHours()).padStart(2, '0')}:${String(nextRunAt.getMinutes()).padStart(2, '0')}`;

    // It says the time to go; its clock time is in its tooltip.
    const scheduled = tile([], 'claude', { state: 'scheduled', schedule });
    expect(scheduled).toMatch(/data-testid="tile-clock"[^>]*>.*<\/svg>in (60 m|1 h)</);
    expect(scheduled).toMatch(new RegExp(`data-testid="tile-clock"[^>]*title="Next run (tomorrow )?${time}`));
    expect(scheduled).toContain('data-state="scheduled"');
    expect(scheduled).toContain('>scheduled<');
    expect(tile([], 'claude', { schedule: { ...schedule, enabled: false, nextRunAt: null } })).toMatch(/data-testid="tile-clock"[^>]*>.*<\/svg>paused</);
    expect(tile([])).not.toContain('data-testid="tile-clock"');
    expect(tile([])).toContain('aria-label="More"');
  });

  it('draws no perch for an agent without subagents', () => {
    expect(tile([])).not.toContain('data-testid="subagent-perch"');
  });
});
