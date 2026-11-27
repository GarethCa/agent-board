// A tool call with an argument its schema lacks is refused, naming the arguments the tool does take, before it reaches the board.
import { describe, expect, it } from 'vitest';
import { boardMcpHandlers } from '../src/board-mcp.ts';
import { BoardError } from '../src/board-ops.ts';

/** Calls `name` on a server whose board answers every call that gets through with "reached the board". */
async function call(name: string, args: Record<string, unknown>) {
  const handlers = boardMcpHandlers({
    openSession: () => Promise.reject(new BoardError('reached the board')),
    cwd: () => process.cwd(),
  });
  const result = await handlers['tools/call']({ name, arguments: args }, { signal: new AbortController().signal } as never);
  return { text: result.content.map((each) => (each.type === 'text' ? each.text : '')).join(''), isError: result.isError === true };
}

describe('a tool call with arguments the tool lacks', () => {
  it('is refused, naming the unknown argument and the valid ones', async () => {
    const answer = await call('set_status', { summary: 'Fixing it', timeout_second: 30 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('timeout_second');
    expect(answer.text).toMatch(/summary, description, character/);
    expect(answer.text).not.toContain('reached the board');
  });

  it('names every unknown argument at once', async () => {
    const answer = await call('set_status', { summry: 'x', progres: 3 });
    expect(answer.text).toMatch(/summry.*progres/);
  });

  it('says a tool with no arguments takes none', async () => {
    const answer = await call('usage', { zone: 'zone:1234' });
    expect(answer).toEqual({ text: 'usage takes no arguments, not zone.', isError: true });
  });

  it('checks the keys of an object argument too, by its path', async () => {
    const answer = await call('set_status', { summary: 'x', character: { pose: 'thinking', mood: 'happy' } });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('character has no mood');
    expect(answer.text).toContain('pose, face, prop');
  });

  it('checks the objects in an array argument, by their place', async () => {
    const answer = await call('set_page', { blocks: [{ kind: 'note', title: 'a' }, { kind: 'checklist', items: [{ text: 'a', done: true }] }] });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('blocks[1].items[0] has no done');
  });

  it('lets a call with only known arguments through', async () => {
    expect(await call('set_status', { summary: 'x', character: { pose: 'thinking' } })).toEqual({ text: 'reached the board', isError: true });
    expect(await call('board', {})).toEqual({ text: 'reached the board', isError: true });
  });

  it('leaves the keys of a free-form object alone', async () => {
    expect(await call('new_agent', { prompt: 'x', env: { ANY_NAME: '1' } })).toEqual({ text: 'reached the board', isError: true });
  });

  it('names the unknown keys at every level in one refusal', async () => {
    const answer = await call('set_page', {
      colour: 'red',
      blocks: [{ kind: 'note', title: 'a', size: 2 }, { kind: 'checklist', items: [{ text: 'a', done: true }] }],
    });
    expect(answer.isError).toBe(true);
    expect(answer.text.split('\n')).toEqual([
      expect.stringMatching(/^set_page has no argument colour\. Its arguments are: name, icon, blocks, clear\.$/),
      expect.stringMatching(/^set_page: blocks\[0\] has no size\. /),
      expect.stringMatching(/^set_page: blocks\[1\]\.items\[0\] has no done\. Its keys are: text, state\.$/),
    ]);
  });

  it("checks an edge's conditions", async () => {
    const answer = await call('add_edge', { from: 'a', to: 'b', carries: 'message', conditions: [{ kind: 'script', cmd: 'true' }] });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('conditions[0] has no cmd');
  });
});
