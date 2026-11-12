import { needsYouKind, type Agent, type AgentCharacter, type NeedsYouFacts } from './protocol.ts';

/**
 * Every pose a character can strike, the board's and the agent's: one per state an agent can be drawn in.
 * The renderer draws each; the words an agent sets and reads (`AGENT_POSES`, `poseWord`) name some of them.
 */
export const CHARACTER_POSES = [
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
] as const;
export type CharacterPose = (typeof CHARACTER_POSES)[number];

/** The poses an agent may set for itself (or its orchestrator for it): only for work it is doing; the rest are the board's. */
export const AGENT_POSES = ['thinking', 'running-a-tool', 'reading', 'writing', 'testing', 'waiting-on-review'] as const;
export type AgentPose = (typeof AGENT_POSES)[number];

/** The faces an agent may give its pose. */
export const AGENT_FACES = ['neutral', 'focused', 'happy', 'puzzled', 'surprised', 'sleepy'] as const;
export type AgentFace = (typeof AGENT_FACES)[number];

/** The props an agent may give its pose, drawn in the working colour whatever it is. */
export const AGENT_PROPS = ['dots', 'gear', 'book', 'pencil', 'flask', 'magnifier', 'wrench', 'doc', 'docclock'] as const;
export type AgentProp = (typeof AGENT_PROPS)[number];

/** The pose that takes the agent's own off, back to the board's. */
export const NO_POSE = 'none';

/** A set of an agent's character: a pose (or `none`), with a face and a prop of its own if it gives them. */
export interface CharacterSet {
  pose: AgentPose | typeof NO_POSE;
  face?: AgentFace;
  prop?: AgentProp;
}

/** A working pose with no new set lasts this long, at most: an agent that forgets to change it isn't drawn at it all day. */
export const CHARACTER_EXPIRY_MS = 20 * 60_000;

/** The poses an agent sets as its turn ends, kept until its next turn starts; every other pose of its own is a working one. */
const RESTING_POSES: ReadonlySet<AgentPose> = new Set<AgentPose>(['waiting-on-review']);

export function isRestingPose(pose: AgentPose): boolean {
  return RESTING_POSES.has(pose);
}

/** The board's pose each agent pose is drawn as. */
const DRAWN_AS: Record<AgentPose, CharacterPose> = {
  thinking: 'thinking',
  'running-a-tool': 'running',
  reading: 'reading',
  writing: 'writing',
  testing: 'testing',
  'waiting-on-review': 'waiting-on-review',
};

/**
 * The board's poses an agent's own pose is drawn over: its work, and its rest at its prompt. The board's attention
 * (needs you, a problem, its usage limit, a restart, paused, starting) and its facts (done, handing off, on a
 * command) win, and the agent's pose waits underneath.
 */
const UNDER_AGENT: ReadonlySet<CharacterPose> = new Set<CharacterPose>(['running', 'thinking', 'reading', 'writing', 'testing', 'idle', 'waiting-on-review']);

/**
 * Whether `pose`, the agent's own, is drawn over `plain`, the pose the board would draw: over its work and its rest.
 * What it asks of you (a permission, a question, a plan, a flag, a steps card) wins by the agent's own facts, as a
 * tile seen since draws `plain` at rest with the ask still open. A turn over leaves only a resting pose: a working one
 * that outlived its turn (a `Stop` that never came) is not drawn at its prompt.
 */
function agentDrawn(plain: CharacterPose, pose: AgentPose, agent: NeedsYouFacts): boolean {
  if (agent.state === 'needs-permission' || needsYouKind(agent, 'explicit') !== null) return false;
  if ((agent.state === 'idle' || agent.state === 'waiting') && !isRestingPose(pose)) return false;
  return UNDER_AGENT.has(plain);
}

/** The pose drawn for `agent`: its own over `plain`, the pose the board would draw, where the board lets it. */
export function poseShown(plain: CharacterPose, agent: NeedsYouFacts & Pick<Agent, 'character'>): CharacterPose {
  return lookShown(plain, agent).pose;
}

/**
 * How a character is drawn: its pose, and when that pose is the agent's own, the face and prop it gave and who set it.
 * A board's pose keeps its own face and prop: the crossed eyes of a problem can't be changed.
 */
export interface CharacterLook {
  pose: CharacterPose;
  face?: AgentFace;
  prop?: AgentProp;
  /** Set only for the agent's own pose: null when the agent set it, or its orchestrator's name. */
  setBy?: string | null;
}

/** The look drawn for `agent`: its own pose, face and prop over `plain`, the pose the board would draw, where the board lets it. */
export function lookShown(plain: CharacterPose, agent: NeedsYouFacts & Pick<Agent, 'character'>): CharacterLook {
  // `?? null`: an agent from an older daemon has no `character`, and draws the board's pose.
  const own = agent.character ?? null;
  if (own === null || !agentDrawn(plain, own.pose, agent)) return { pose: plain };
  return { pose: DRAWN_AS[own.pose], ...(own.face === null ? {} : { face: own.face }), ...(own.prop === null ? {} : { prop: own.prop }), setBy: own.setBy };
}

/** The word for each pose an agent reads back (`shown`): its own poses' words, and the board's states by their names. */
const POSE_WORDS: Record<CharacterPose, string> = {
  running: 'running-a-tool',
  thinking: 'thinking',
  waiting: 'needs-you',
  'needs-permission': 'needs-you',
  idle: 'idle',
  'rate-limited': 'usage-limit',
  failed: 'problem',
  done: 'done',
  'handing-off': 'handing-off',
  'on-command': 'on-command',
  starting: 'starting',
  reading: 'reading',
  writing: 'writing',
  testing: 'testing',
  'waiting-on-review': 'waiting-on-review',
  hibernated: 'paused',
  'stopped-by-restart': 'stopped-by-restart',
};

export function poseWord(pose: CharacterPose): string {
  return POSE_WORDS[pose];
}

/**
 * The pose the board draws an agent at by its own reading, before the agent's: what it asks of the user first, then
 * its state. The renderer reads each design's own (its pill, its status word); this is the one the daemon answers with,
 * as a tile not yet seen draws it with needs-you left at what agents ask: a turn that ended asking nothing rests.
 */
export function boardPose(agent: NeedsYouFacts): CharacterPose {
  if (agent.endedAt === null && needsYouKind(agent, 'explicit') !== null) return agent.state === 'needs-permission' ? 'needs-permission' : 'waiting';
  if (agent.endedAt === null && agent.state === 'waiting') return 'idle';
  // A schedule's next run is timed as a command left running is.
  return agent.state === 'scheduled' ? 'on-command' : agent.state;
}

/** When a working pose lapses with no new set (ISO), or null for a resting one, which lasts until the next turn starts. */
export function characterExpiresAt(character: Pick<AgentCharacter, 'pose' | 'setAt'>): string | null {
  return isRestingPose(character.pose) ? null : new Date(Date.parse(character.setAt) + CHARACTER_EXPIRY_MS).toISOString();
}

/** Whether a pose set is still the agent's at `now`: a working one lapses `CHARACTER_EXPIRY_MS` after its set. */
export function characterLive(character: Pick<AgentCharacter, 'pose' | 'setAt'>, now: number = Date.now()): boolean {
  const expiresAt = characterExpiresAt(character);
  return expiresAt === null || Date.parse(expiresAt) > now;
}

/** When the agent's pose goes, in words, told to it (`your`) or of it (`its`). */
export function characterExpiry(character: Pick<AgentCharacter, 'pose'>, whose: 'your' | 'its' = 'your'): string {
  return isRestingPose(character.pose) ? `when ${whose} next turn starts` : 'at turn end, or 20 minutes after this set';
}

/** What the agent reads back of its character: the pose drawn, its own if it set one, and when its own goes. */
export interface CharacterReading {
  shown: string;
  yours: AgentPose | null;
  /** Whose the pose is: `you`, or the orchestrator that set it for you. Null with none set. */
  setBy: string | null;
  expires: string | null;
}

/** The agent's character as it reads it back, or (`its`) as its orchestrator reads it. */
export function characterReading(agent: NeedsYouFacts & Pick<Agent, 'character'>, whose: 'your' | 'its' = 'your'): CharacterReading {
  const { character } = agent;
  return {
    shown: poseWord(poseShown(boardPose(agent), agent)),
    yours: character?.pose ?? null,
    setBy: character === null ? null : (character.setBy ?? 'you'),
    expires: character === null ? null : characterExpiry(character, whose),
  };
}

const listed = (words: readonly string[]): string => words.join(', ');

/** Reads a set of an agent's character from params or flags; throws an error naming the list for a word outside it. */
export function parseCharacter(value: unknown): CharacterSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('character must be an object with a pose, and a face and a prop if you like');
  const { pose, face, prop, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`character takes pose, face and prop, not ${extra}`);
  if (pose === undefined) throw new Error(`character needs a pose; poses: ${listed([...AGENT_POSES, NO_POSE])}`);
  if (pose !== NO_POSE && !(AGENT_POSES as readonly unknown[]).includes(pose)) {
    throw new Error(`unknown pose '${String(pose)}'; poses: ${listed([...AGENT_POSES, NO_POSE])}`);
  }
  if (face !== undefined && !(AGENT_FACES as readonly unknown[]).includes(face)) throw new Error(`unknown face '${String(face)}'; faces: ${listed(AGENT_FACES)}`);
  if (prop !== undefined && !(AGENT_PROPS as readonly unknown[]).includes(prop)) throw new Error(`unknown prop '${String(prop)}'; props: ${listed(AGENT_PROPS)}`);
  if (pose === NO_POSE && (face !== undefined || prop !== undefined)) throw new Error(`pose ${NO_POSE} takes no face or prop: it gives the board's pose back`);
  return {
    pose: pose as CharacterSet['pose'],
    ...(face === undefined ? {} : { face: face as AgentFace }),
    ...(prop === undefined ? {} : { prop: prop as AgentProp }),
  };
}

/** What `status poses` lists: every word an agent may set. */
export function characterChoices(): string {
  return [
    `poses: ${listed([...AGENT_POSES, NO_POSE])}`,
    `faces: ${listed(AGENT_FACES)}`,
    `props: ${listed(AGENT_PROPS)}`,
    `A working pose lasts until your turn ends, or 20 minutes with no new set; ${listed([...RESTING_POSES])} lasts until your next turn starts.`,
    'The board draws its own states over yours (needs you, a problem, a usage limit, paused, done), and yours shows again after.',
  ].join('\n');
}
