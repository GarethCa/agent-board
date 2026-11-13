import { describe, expect, it } from 'vitest';
import {
  AGENT_POSES,
  CHARACTER_EXPIRY_MS,
  characterChoices,
  characterLive,
  characterReading,
  lookShown,
  parseCharacter,
  poseShown,
  type CharacterPose,
} from '../src/character.ts';
import type { Agent, AgentCharacter } from '../src/protocol.ts';

const set = (pose: AgentCharacter['pose'], extra: Partial<AgentCharacter> = {}): AgentCharacter => ({
  pose,
  face: null,
  prop: null,
  setAt: '2026-11-10T18:00:00.000Z',
  setBy: null,
  ...extra,
});

/** The facts `characterReading` reads of an agent: live, at work, asking nothing. */
const agent = (extra: Partial<Agent> = {}): Agent =>
  ({ state: 'running', endedAt: null, permissions: [], ask: null, removeAsk: null, plan: null, stepsWait: null, flag: null, ledBy: null, character: null, ...extra }) as unknown as Agent;

describe("reading an agent's character", () => {
  it('names every pose an agent may set, a face and a prop, and refuses a word outside them by naming the list', () => {
    expect(parseCharacter({ pose: 'testing', face: 'focused', prop: 'flask' })).toEqual({ pose: 'testing', face: 'focused', prop: 'flask' });
    expect(parseCharacter({ pose: 'none' })).toEqual({ pose: 'none' });
    expect(() => parseCharacter({ pose: 'dancing' })).toThrow(/^unknown pose 'dancing'; poses: thinking, running-a-tool, reading, writing, testing, waiting-on-review, none$/);
    expect(() => parseCharacter({ pose: 'testing', face: 'grumpy' })).toThrow(/unknown face 'grumpy'; faces: neutral, focused/);
    expect(() => parseCharacter({ pose: 'testing', prop: 'hammer' })).toThrow(/unknown prop 'hammer'; props: dots, gear/);
    expect(() => parseCharacter({ face: 'happy' })).toThrow(/needs a pose; poses: thinking/);
    expect(() => parseCharacter({ pose: 'testing', hat: 'top' })).toThrow(/not hat/);
    expect(() => parseCharacter({ pose: 'none', face: 'happy' })).toThrow(/takes no face or prop/);
    expect(() => parseCharacter('testing')).toThrow(/must be an object/);
    // The board's own states are not the agent's to set.
    expect(() => parseCharacter({ pose: 'failed' })).toThrow(/unknown pose 'failed'/);
  });

  it("draws the agent's pose over its work and its rest, and the board's attention and facts over the agent's", () => {
    expect(poseShown('running', agent({ character: set('testing') }))).toBe('testing');
    expect(poseShown('idle', agent({ state: 'idle', character: set('waiting-on-review') }))).toBe('waiting-on-review');
    expect(poseShown('thinking', agent({ character: set('running-a-tool') }))).toBe('running');
    expect(poseShown('running', agent())).toBe('running');
    const boards: CharacterPose[] = ['needs-permission', 'failed', 'rate-limited', 'hibernated', 'stopped-by-restart', 'starting', 'done', 'handing-off', 'on-command'];
    for (const plain of boards) expect(poseShown(plain, agent({ character: set('writing') }))).toBe(plain);
  });

  it("draws what it asks of you over its pose, whatever the board would draw: a tile seen since draws the ask at rest", () => {
    const asks: Partial<Agent>[] = [
      { state: 'needs-permission' },
      { state: 'waiting', ask: {} as Agent['ask'] },
      { state: 'waiting', plan: { decision: null } as Agent['plan'] },
      { state: 'waiting', stepsWait: { kind: 'steps' } as Agent['stepsWait'] },
      { state: 'idle', flag: { to: 'user' } as Agent['flag'] },
    ];
    for (const facts of asks) {
      for (const pose of ['testing', 'waiting-on-review'] as const) {
        // Seen, its pill rests; unseen, it says what it waits for. Neither lets the pose through.
        expect(poseShown('idle', agent({ ...facts, character: set(pose) }))).toBe('idle');
        expect(poseShown('waiting-on-review', agent({ ...facts, character: set(pose) }))).toBe('waiting-on-review');
        expect(poseShown('waiting', agent({ ...facts, character: set(pose) }))).toBe('waiting');
      }
    }
    // A flag to its orchestrator is not the user's to answer.
    expect(poseShown('idle', agent({ state: 'idle', flag: { to: 'orchestrator' } as Agent['flag'], character: set('waiting-on-review') }))).toBe('waiting-on-review');
  });

  it("leaves the board's needs you for a finished turn alone, and draws only a resting pose once a turn is over", () => {
    // Needs you set to count finished turns, the turn not yet seen: the board's, not the pose's.
    expect(poseShown('waiting', agent({ state: 'waiting', character: set('waiting-on-review') }))).toBe('waiting');
    // Seen, or finished turns not counted: it rests, on what the agent says.
    expect(poseShown('idle', agent({ state: 'waiting', character: set('waiting-on-review') }))).toBe('waiting-on-review');
    // A working pose that outlived its turn is not drawn at its prompt, by either design's reading of it.
    for (const state of ['idle', 'waiting'] as const) {
      expect(poseShown('idle', agent({ state, character: set('testing') }))).toBe('idle');
      expect(poseShown('running', agent({ state, character: set('testing') }))).toBe('running');
      expect(poseShown('waiting-on-review', agent({ state, character: set('testing') }))).toBe('waiting-on-review');
    }
  });

  it("draws the agent's face and prop, and who set them, only with its own pose: a board's pose keeps its own", () => {
    const own = set('reading', { face: 'puzzled', prop: 'magnifier' });
    expect(lookShown('running', agent({ character: own }))).toEqual({ pose: 'reading', face: 'puzzled', prop: 'magnifier', setBy: null });
    expect(lookShown('running', agent({ character: set('testing', { setBy: 'lead' }) }))).toEqual({ pose: 'testing', setBy: 'lead' });
    expect(lookShown('failed', agent({ character: own }))).toEqual({ pose: 'failed' });
    expect(lookShown('running', agent())).toEqual({ pose: 'running' });
    // An agent from an older daemon has no character at all.
    expect(lookShown('running', { ...agent(), character: undefined } as unknown as Agent)).toEqual({ pose: 'running' });
  });

  it('says what is shown, whose the pose is, and when it goes', () => {
    expect(characterReading(agent())).toEqual({ shown: 'running-a-tool', yours: null, setBy: null, expires: null });
    expect(characterReading(agent({ character: set('testing') }))).toEqual({
      shown: 'testing',
      yours: 'testing',
      setBy: 'you',
      expires: 'at turn end, or 20 minutes after this set',
    });
    expect(characterReading(agent({ state: 'idle', character: set('waiting-on-review', { setBy: 'lead' }) }), 'its')).toEqual({
      shown: 'waiting-on-review',
      yours: 'waiting-on-review',
      setBy: 'lead',
      expires: 'when its next turn starts',
    });
    // Asking for permission, it is drawn needing you, its pose under it.
    expect(characterReading(agent({ state: 'needs-permission', character: set('testing') }))).toMatchObject({ shown: 'needs-you', yours: 'testing' });
    expect(characterReading(agent({ state: 'failed', character: set('testing') }))).toMatchObject({ shown: 'problem' });
    // A turn that ended asking nothing rests, as its tile draws it: on what the agent says, if it says.
    expect(characterReading(agent({ state: 'waiting' }))).toMatchObject({ shown: 'idle' });
    expect(characterReading(agent({ state: 'waiting', character: set('waiting-on-review') }))).toMatchObject({ shown: 'waiting-on-review' });
    expect(characterReading(agent({ state: 'idle', character: set('testing') }))).toMatchObject({ shown: 'idle', yours: 'testing' });
    expect(characterReading(agent({ state: 'waiting', ask: {} as Agent['ask'], character: set('waiting-on-review') }))).toMatchObject({ shown: 'needs-you' });
  });

  it('lapses a working pose 20 minutes after its set, and keeps a resting one', () => {
    const at = Date.parse('2026-11-10T18:00:00.000Z');
    expect(characterLive(set('testing'), at + CHARACTER_EXPIRY_MS - 1)).toBe(true);
    expect(characterLive(set('testing'), at + CHARACTER_EXPIRY_MS)).toBe(false);
    expect(characterLive(set('waiting-on-review'), at + 10 * CHARACTER_EXPIRY_MS)).toBe(true);
  });

  it('lists every word an agent may set', () => {
    const text = characterChoices();
    for (const pose of AGENT_POSES) expect(text).toContain(pose);
    expect(text).toMatch(/^poses: .*, none\nfaces: neutral, .*\nprops: dots, /);
  });
});
