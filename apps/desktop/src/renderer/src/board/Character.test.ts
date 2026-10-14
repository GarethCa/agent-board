import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent, Subagent } from '@agent-board/daemon/protocol';
import { Character, CHARACTER_POSES } from './Character';
import { CharacterGallery } from './CharacterGallery';
import { HybridTile } from './HybridTile';
import { MAX_PERCHED } from './perch';
import type { TileData } from './tile';

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

  it('shows all nine poses', () => {
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
    ]);
    expect(new Set(pick(gallery, 'data-pose').flat())).toEqual(new Set(CHARACTER_POSES));
  });

  it('draws each pose with a bean body for Claude and a block body for Codex', () => {
    for (const pose of CHARACTER_POSES) {
      const posed = gallery.filter((c) => c.attributes['data-pose'] === pose);
      expect(pick(posed, 'data-harness', 'data-body')).toEqual([
        ['claude', 'bean'],
        ['codex', 'block'],
      ]);
    }
  });

  it('gives each pose its own drawing', () => {
    const drawings = gallery.filter((c) => c.attributes['data-body'] === 'bean').map((c) => c.drawing);
    expect(drawings).toHaveLength(CHARACTER_POSES.length);
    expect(new Set(drawings).size).toBe(CHARACTER_POSES.length);
  });
});

describe('a character', () => {
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

  function tile(subagents: Subagent[], harness: 'claude' | 'codex' = 'claude', fields: Partial<Agent> = {}): string {
    const data: TileData = {
      label: 'agent',
      harness,
      agent: {
        sessionId: 's1',
        zoneId: 'z1',
        repoRoot: '/code/app',
        position: null,
        harness,
        model: null,
        role: null,
        name: 'agent',
        description: 'Map the code',
        branch: 'map-the-code',
        worktree: '/tmp/w',
        cwd: '/tmp/w',
        state: 'running',
        notice: null,
        muted: false,
        seen: false,
        issue: null,
        createdAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        shellSessionId: null,
        subagents,
        pullRequests: [],
        lastMessage: null,
        permissions: [],
        schedule: null,
        reviewOf: null,
        reviewCap: 3,
        ownsWorktree: true,
        orchestrate: null,
        spawnedBy: null,
        status: null,
        ...fields,
      },
    };
    return renderToStaticMarkup(createElement(HybridTile, { id: 'agent:s1', tile: data }));
  }

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
    const schedule = { cron: '0 * * * *', prompt: 'Sweep', enabled: true, nextRunAt: nextRunAt.toISOString(), lastRun: null };
    const time = `${String(nextRunAt.getHours()).padStart(2, '0')}:${String(nextRunAt.getMinutes()).padStart(2, '0')}`;

    const scheduled = tile([], 'claude', { state: 'scheduled', schedule });
    expect(scheduled).toMatch(new RegExp(`data-testid="tile-clock"[^>]*>.*</svg>(tomorrow )?${time}<`));
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
