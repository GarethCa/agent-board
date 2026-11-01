import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { projectSummaries } from './project-summary';
import { galleryAgent } from './TileGallery';

const agent = (sessionId: string, state: Agent['state'], zoneId: string | null, more: Partial<Agent> = {}): Agent => ({ ...galleryAgent(state), sessionId, zoneId, ...more });

describe("a project's summary", () => {
  it('counts the agents that need you apart, and the rest by status, those that want you first', () => {
    const summaries = projectSummaries(
      [agent('a', 'needs-permission', 'z1'), agent('b', 'running', 'z1'), agent('c', 'done', 'z1'), agent('d', 'thinking', 'z1'), agent('e', 'running', 'z2')],
      'explicit',
    );
    expect(summaries.get('z1')).toEqual({ needsYou: 1, line: '2 working · 1 done' });
    expect(summaries.get('z2')).toEqual({ needsYou: 0, line: '1 working' });
  });

  it('has none for a project with no agents, and leaves out agents outside every project', () => {
    const summaries = projectSummaries([agent('a', 'running', null)], 'explicit');
    expect(summaries.size).toBe(0);
  });
});
