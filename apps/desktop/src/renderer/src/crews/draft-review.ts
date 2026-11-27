// A drafted crew as the user finds and reviews it: its row in Needs you, its place first in the crew library, and what
// it will start (its agents, their roles and models, its inputs and its lines), said plainly. Pure, for its tests.
import { isOrchestratorRole, type CrewPrefab, type Harness, type PrefabDraft } from '@agent-board/daemon/protocol';
import { sinceText } from '../../../shared/needs-you';
import { boardDraft, inputName, lineWords, type BoardDraft } from './prefab-board';
import { memberLabel, memberModel } from './prefab-flow';

const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude', codex: 'Codex' };
const ROLE_NAMES: Readonly<Record<string, string>> = { implementer: 'Builder', reviewer: 'Reviewer', 'follow-up-reviewer': 'Follow-up reviewer' };

/** A draft's row in Needs you: who drafted which crew. */
export const draftNeedsYou = (draft: PrefabDraft): { id: string; text: string } => ({ id: draft.id, text: `${draft.drafter.name} drafted a crew: ${draft.prefab.name}` });

/** The drafts as the crew library lists them, newest first; drafts made at once keep their order. */
export const draftsToReview = (drafts: readonly PrefabDraft[]): PrefabDraft[] => [...drafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** Who drafted it and when, under its name: `Drafted by Captain · 4 min ago`. */
export const draftedBy = (draft: PrefabDraft, now: number): string => `Drafted by ${draft.drafter.name} · ${sinceText(draft.createdAt, now)}`;

/** One agent a draft starts, as its review lists it. */
export interface DraftAgent {
  id: string;
  name: string;
  role: string;
  model: string;
}

/** What a draft will start: its agents, its inputs by their pills' words, and each line as a sentence. */
export interface DraftSummary {
  agents: DraftAgent[];
  inputs: string[];
  lines: string[];
}

const roleName = (role: string | null): string => {
  if (role === null || role.trim() === '') return 'Agent';
  if (isOrchestratorRole(role)) return 'Lead';
  return ROLE_NAMES[role.toLowerCase()] ?? role;
};

/** `board` is the prefab as its board holds it, if it is open on one, which saves laying it out again. */
export function draftSummary(prefab: CrewPrefab, board?: BoardDraft): DraftSummary {
  const draft = board ?? boardDraft(prefab);
  return {
    agents: prefab.members.map((member) => ({
      id: member.id,
      name: memberLabel(member),
      role: roleName(member.role),
      model: `${HARNESS_NAMES[member.harness]} · ${member.model === null && member.effort === null ? 'its defaults' : memberModel(member)}`,
    })),
    inputs: draft.inputs.map(({ input }) => inputName(input)),
    lines: draft.lines.map((line) => lineWords(draft, line)),
  };
}
