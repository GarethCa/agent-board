import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFailed } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { DatabaseSync } from 'node:sqlite';
import { checkDiagram, createSelectionAsks, parseAnswer, selectionPrompt, SUGGESTIONS_FENCE } from '../src/selection-asks.ts';
import { migrate } from '../src/migrate.ts';
import type { Agent, AgentNoteData, BoardItem, DaemonEvent, SelectionDiagram } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const DIAGRAM: SelectionDiagram = {
  nodes: [
    { id: 'n1', kind: 'shape', shape: 'rounded', text: 'API gateway', x: 0, y: 40, width: 120, height: 60 },
    { id: 'n2', kind: 'shape', shape: 'service', text: 'Orders service', x: 200, y: 40, width: 130, height: 70 },
    { id: 'n3', kind: 'shape', shape: 'database', text: 'Postgres', x: 400, y: 30, width: 100, height: 90 },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: 'orders' },
    { from: 'n2', to: 'n3' },
  ],
  groups: [{ name: 'Checkout', nodes: ['n1', 'n2', 'n3'] }],
};

const OBJECTS = { n1: { type: 'item', id: 'i1' }, n2: { type: 'item', id: 'i2' }, n3: { type: 'item', id: 'i3' } } as const;

describe('selectionPrompt', () => {
  const files = { picture: '/data/selection-asks/a1/selection.png', diagram: '/data/selection-asks/a1/selection.json' };

  it('starts with what was asked, then names the picture and the diagram, and holds the diagram itself', () => {
    const prompt = selectionPrompt({ question: 'What is risky here?', diagram: DIAGRAM, readRepo: false, suggest: false }, files);
    expect(prompt.split('\n')[0]).toBe('What is risky here?');
    expect(prompt).toContain('3 objects, 2 arrows, 3 shapes among them');
    expect(prompt).toContain('The picture: `/data/selection-asks/a1/selection.png` (drawn at 2×: only the selected objects, cropped to them)');
    expect(prompt).toContain('`/data/selection-asks/a1/selection.json`');
    expect(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]!)).toEqual(DIAGRAM);
    expect(prompt).toContain("You have no copy of the user's code");
    expect(prompt).not.toContain(SUGGESTIONS_FENCE);
  });

  it('lets it read the repo, and asks for suggestions in a fenced block when they are wanted', () => {
    const prompt = selectionPrompt({ question: 'Review this', diagram: DIAGRAM, readRepo: true, suggest: true, pictureScale: 1.25 }, files);
    expect(prompt).toContain('(drawn at 1.25×:');
    expect(prompt).toContain('read it for context. You are in a read-only mode: change nothing.');
    expect(prompt).toContain(`fenced block tagged ${SUGGESTIONS_FENCE}`);
    expect(prompt).toContain('database');
  });
});

describe('parseAnswer', () => {
  const context = { objects: OBJECTS, origin: { x: 1000, y: 500 } };
  const block = (json: unknown) => `**1 risk**\n\n1. Use an outbox.\n\n\`\`\`${SUGGESTIONS_FENCE}\n${JSON.stringify(json)}\n\`\`\``;

  it('takes the suggestions block out of the text, and puts its shapes on the board from the selection’s origin', () => {
    const answer = parseAnswer(
      block([{ title: 'Outbox', shapes: [{ id: 's1', shape: 'database', text: 'outbox', x: 400, y: 180, width: 90, height: 70 }], arrows: [{ from: 'n2', to: 's1', label: 'writes' }] }]),
      context,
    );
    expect(answer.text).toBe('**1 risk**\n\n1. Use an outbox.');
    expect(answer.suggestions).toEqual([
      {
        id: '1',
        title: 'Outbox',
        shapes: [{ key: 's1', shape: 'database', text: 'outbox', x: 1400, y: 680, width: 90, height: 70 }],
        arrows: [{ from: { object: { type: 'item', id: 'i2' } }, to: { shape: 's1' }, label: 'writes' }],
      },
    ]);
  });

  it('keeps an answer with no block as it is, and one with a block that is not JSON without it', () => {
    expect(parseAnswer('Looks fine.', context)).toEqual({ text: 'Looks fine.', suggestions: [] });
    expect(parseAnswer(`Fine.\n\n\`\`\`${SUGGESTIONS_FENCE}\nnot json\n\`\`\``, context)).toEqual({ text: 'Fine.', suggestions: [] });
  });

  it('drops what makes no sense: an unknown shape or node, no title, nothing to add; and numbers what is left', () => {
    const answer = parseAnswer(
      block([
        { title: 'Unknown shape', shapes: [{ id: 's1', shape: 'blob', x: 0, y: 0, width: 10, height: 10 }] },
        { title: 'Unknown node', arrows: [{ from: 'n9', to: 'n1' }] },
        { shapes: [{ id: 's1', shape: 'cloud', x: 0, y: 0, width: 10, height: 10 }] },
        { title: 'Two gateways', shapes: [{ id: 'g', shape: 'rounded', text: 'Gateway 2', x: 0, y: 140, width: 5, height: 99999 }], arrows: [{ from: 'g', to: 'n2' }, { from: 'n1', to: 'n1' }] },
        { title: 'Cache tokens', arrows: [{ from: 'n1', to: 'n3', label: 'cache' }] },
      ]),
      context,
    );
    expect(answer.suggestions.map(({ id, title }) => [id, title])).toEqual([
      ['1', 'Two gateways'],
      ['2', 'Cache tokens'],
    ]);
    // Sizes are kept within reason, and an arrow from a node to itself is dropped.
    expect(answer.suggestions[0]!.shapes[0]).toMatchObject({ width: 16, height: 1000 });
    expect(answer.suggestions[0]!.arrows).toHaveLength(1);
  });
});

describe('checkDiagram', () => {
  it('takes a diagram whose edges and groups name its nodes', () => {
    expect(checkDiagram(DIAGRAM)).toEqual(DIAGRAM);
  });

  it.each([
    ['no nodes', { nodes: [], edges: [], groups: [] }, /something in it/],
    ['an edge to a node it lacks', { ...DIAGRAM, edges: [{ from: 'n1', to: 'n7' }] }, /join two of its nodes/],
    ['a node with no box', { ...DIAGRAM, nodes: [{ id: 'n1', kind: 'shape' }] }, /node must be/],
    ['a huge one', { ...DIAGRAM, nodes: [{ ...DIAGRAM.nodes[0]!, text: 'x'.repeat(70_000) }], edges: [], groups: [] }, /too large/],
  ])('refuses %s', (_, diagram, message) => {
    expect(() => checkDiagram(diagram)).toThrow(message);
  });
});

/** A daemon running the `ask-selection` fake, a zone on a repo with the diagram's three shapes in it, and a picture staged. */
async function askDaemon() {
  const dataDir = tempDataDir();
  const scratchDir = tempDataDir();
  const logged: string[] = [];
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    scratchDir,
    agentEnv: fakeHarnessEnv({ scenario: 'ask-selection', home: tempDataDir() }),
    log: (line) => logged.push(line),
  });
  onTestFailed(() => console.log(logged.join('\n')));
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'Checkout' });
  const shapes: BoardItem[] = [];
  for (const node of DIAGRAM.nodes) {
    shapes.push(
      await client.call('item.create', {
        kind: 'shape',
        zoneId: zone.id,
        x: 100 + node.x,
        y: 100 + node.y,
        width: node.width,
        height: node.height,
        data: { shape: node.shape, fill: null, stroke: '#333333', strokeWidth: 2, dashed: false, text: node.text, textSize: 'body', bold: false, textColor: '#333333' },
      }),
    );
  }
  const incoming = join(dataDir, 'images', 'incoming');
  mkdirSync(incoming, { recursive: true });
  writeFileSync(join(incoming, 'shot'), PNG);
  const ask = async (readRepo: boolean) => {
    const agent = await client.call('selection.ask', {
      question: 'What is risky here?',
      zoneId: zone.id,
      readRepo,
      suggest: true,
      diagram: DIAGRAM,
      objects: { n1: { type: 'item', id: shapes[0]!.id }, n2: { type: 'item', id: shapes[1]!.id }, n3: { type: 'item', id: shapes[2]!.id } },
      origin: { x: 100, y: 100 },
      picturePath: join(incoming, 'shot'),
      pictureScale: 2,
      anchor: 'n3',
      note: { zoneId: zone.id, x: 660, y: 100 },
      tile: { zoneId: zone.id, x: 660, y: 600 },
      cols: 120,
      rows: 40,
    });
    await client.call('session.attach', { sessionId: agent.sessionId });
    return agent;
  };
  const created = (event: DaemonEvent): event is Extract<DaemonEvent, { type: 'item.updated' }> => event.type === 'item.updated' && event.item.kind === 'agent-note';
  /** The answer's note, once it is on the board. */
  const answer = async () => {
    await recorder.waitFor(created);
    return recorder.events.find(created)!.item;
  };
  return { dataDir, scratchDir, client, recorder, repo, zone, shapes, incoming, ask, answer, created };
}

describe('asking about a selection', () => {
  it('starts an agent with the picture and the diagram, and puts its first answer beside the selection, joined by an arrow', async () => {
    const { dataDir, scratchDir, client, recorder, zone, shapes, incoming, ask, answer, created } = await askDaemon();
    const agent = await ask(false);
    expect(agent).toMatchObject({ role: 'custom', roleName: 'architect', zoneId: zone.id, name: 'Ask: What is risky here?' });

    const note = await answer();
    const data = note.data as unknown as AgentNoteData;
    expect(note).toMatchObject({ zoneId: zone.id, x: 660, y: 100 });
    // The agent read the picture and the diagram it was given.
    expect(data.text).toContain('**Saw 3 shapes and 2 arrows**');
    expect(data.text).toContain('The picture is a PNG, 1×1 px.');
    expect(data.text).toContain('Its nodes: API gateway, Orders service, Postgres.');
    expect(data.text).not.toContain(SUGGESTIONS_FENCE);
    expect(data).toMatchObject({ asked: 'What is risky here?', agent: { sessionId: agent.sessionId, role: 'architect' }, editedByUser: false });
    expect(data.suggestions).toEqual([
      {
        id: '1',
        title: 'Outbox',
        shapes: [{ key: 's1', shape: 'database', text: 'outbox', x: 500, y: 280, width: 90, height: 70 }],
        arrows: [{ from: { object: { type: 'item', id: shapes[2]!.id } }, to: { shape: 's1' }, label: 'writes' }],
      },
    ]);
    // Joined to the selection's node nearest it, and its tile moved under it.
    await expect.poll(async () => (await client.call('connector.list')).map(({ from, to }) => [from.id, to.id])).toEqual([[shapes[2]!.id, note.id]]);
    await expect.poll(async () => (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.position).toMatchObject({ x: 660, y: 100 + note.height + 16 });

    // With no repo to read, it runs in the ask's own folder, outside git: no scratch repo, no worktree, no branch.
    const [folder] = readdirSync(join(dataDir, 'selection-asks'));
    const kept = join(dataDir, 'selection-asks', folder!);
    expect(agent).toMatchObject({ worktree: kept, branch: '', ownsWorktree: false });
    expect(data.text).toContain('outside git, in default mode');
    expect(readdirSync(scratchDir)).toEqual([]);
    // Its picture and diagram are kept there, until it goes.
    expect(readFileSync(join(kept, 'selection.png'))).toEqual(PNG);
    expect(JSON.parse(readFileSync(join(kept, 'selection.json'), 'utf8'))).toEqual(DIAGRAM);
    expect(existsSync(join(incoming, 'shot'))).toBe(false);

    // A follow-up is answered in its terminal: the note stays as it was.
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'Which first?' });
    await recorder.waitForText(agent.sessionId, 'keep the outbox');
    expect(new Set(recorder.events.filter(created).map((event) => event.item.id)).size).toBe(1);

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(existsSync(kept)).toBe(false);
  });

  it('lets it read the zone’s repo in place, read-only: no worktree or branch is cut, and deleting it leaves the checkout', async () => {
    const { scratchDir, client, repo, ask, answer } = await askDaemon();
    const branches = git(repo, 'branch', '--list');
    const agent = await ask(true);
    expect(agent).toMatchObject({ worktree: repo, branch: '', ownsWorktree: false });

    const data = (await answer()).data as unknown as AgentNoteData;
    // Claude started in plan mode, in the user's checkout.
    expect(data.text).toContain('a git checkout, in plan mode');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(git(repo, 'branch', '--list')).toBe(branches);
    expect(readdirSync(scratchDir)).toEqual([]);

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(existsSync(join(repo, 'apps', 'web', 'index.ts'))).toBe(true);
  });

  it('refuses a picture that is not a PNG in images/incoming', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), scratchDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'ask-selection', home: tempDataDir() }) });
    const client = await connectTestClient(daemon);
    const outside = join(tempDataDir(), 'shot.png');
    writeFileSync(outside, PNG);
    const params = {
      question: 'Review',
      zoneId: null,
      readRepo: false,
      suggest: false,
      diagram: DIAGRAM,
      objects: OBJECTS,
      origin: { x: 0, y: 0 },
      picturePath: outside,
      anchor: 'n3',
      note: { zoneId: null, x: 600, y: 0 },
      tile: { zoneId: null, x: 600, y: 260 },
      cols: 120,
      rows: 40,
    };
    await expect(client.call('selection.ask', params)).rejects.toThrow(/images\/incoming/);
    expect(await client.call('agent.list')).toEqual([]);
  });
});

describe('createSelectionAsks', () => {
  /** An ask host over a fresh database, its agent and daemon calls stubbed: what it calls is in `calls`. */
  function host({ answered, moved = false }: { answered?: string; moved?: boolean }) {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const stored = join(tempDataDir(), 'stored.png');
    writeFileSync(stored, PNG);
    const incoming = join(tempDataDir(), 'shot');
    writeFileSync(incoming, PNG);
    const agent = {
      sessionId: 's1',
      name: 'Ask: Review',
      harness: 'claude',
      role: 'custom',
      roleName: 'architect',
      zoneId: 'z1',
      position: { x: 660, y: 600, z: 1 },
    } as unknown as Agent;
    const calls: [string, unknown][] = [];
    const asks = createSelectionAsks({
      db,
      dir: tempDataDir(),
      images: { importFile: () => ({ sha256: 'a'.repeat(64), ext: 'png' }), filePath: () => stored },
      spawn: async () => agent,
      // Moved by the user since it started, or where it was put.
      agent: () => (moved ? { ...agent, position: { x: 900, y: 900, z: 1 } } : agent),
      finalMessage: () => answered,
      zoneRepo: () => null,
      call: (async (method: string, params: unknown) => {
        calls.push([method, params]);
        return method === 'item.create' ? { id: 'note1', height: 150 } : {};
      }) as never,
      log: () => {},
    });
    const params = {
      question: 'Review',
      zoneId: 'z1',
      readRepo: false,
      suggest: false,
      diagram: DIAGRAM,
      objects: OBJECTS,
      origin: { x: 0, y: 0 },
      picturePath: incoming,
      anchor: 'n3',
      note: { zoneId: 'z1', x: 660, y: 100 },
      tile: { zoneId: 'z1', x: 660, y: 600 },
      cols: 120,
      rows: 40,
    };
    return { asks, calls, ask: () => asks.handlers()['selection.ask'](params, undefined) };
  }

  it('puts an answer that came before the ask was recorded on the board at once', async () => {
    const { calls, ask } = host({ answered: '**Fine.**' });
    await ask();
    await expect.poll(() => calls.map(([method]) => method)).toEqual(['item.create', 'connector.create', 'agent.move']);
    expect(calls[0]![1]).toMatchObject({ kind: 'agent-note', data: { text: '**Fine.**', asked: 'Review' } });
  });

  it('leaves the tile where the user moved it, and makes one note however often the turn ends', async () => {
    const { asks, calls, ask } = host({ moved: true });
    await ask();
    expect(calls).toEqual([]);
    await Promise.all([asks.finished('s1', 'First.'), asks.finished('s1', 'Again.')]);
    await asks.finished('s1', 'Later.');
    expect(calls.map(([method]) => method)).toEqual(['item.create', 'connector.create']);
  });
});
