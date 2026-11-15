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
