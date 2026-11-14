// What a zone's issue picker is narrowed to: its select's choices (the scope, each project and its milestones), and
// the choice remembered per zone.
import type { IssueFilters, IssuePick, ZoneTracker } from '@agent-board/daemon/protocol';
import { storedValue } from '../stored-value';

export interface IssuePickOption {
  /** The pick as the select's value: `pickValue(pick)`. */
  value: string;
  label: string;
  /** What the option narrows to: the whole scope, a project, or a milestone. */
  kind: 'scope' | 'project' | 'milestone';
  pick: IssuePick;
}

export interface IssuePickMenu {
  /** The whole scope, first. */
  scope: IssuePickOption;
  /** A group per project (the project, then its milestones), then the milestones outside any project. */
  groups: { label: string; options: IssuePickOption[] }[];
}

/** A pick as one string, the same for the same pick. */
export function pickValue(pick: IssuePick): string {
  return JSON.stringify({ project: pick.project ?? null, ...(pick.milestone === undefined ? {} : { milestone: pick.milestone }) });
}

/** Where the picker starts: a project zone on its own project, any other zone on its whole scope. */
export function defaultPick(tracker: ZoneTracker): IssuePick {
  return { project: tracker.project ?? null };
}

const option = (label: string, kind: IssuePickOption['kind'], pick: IssuePick): IssuePickOption => ({
  value: pickValue(pick),
  label,
  kind,
  pick,
});

/** The select's choices for a zone's tracker and what it can be narrowed to. */
export function issuePickMenu(tracker: ZoneTracker, filters: IssueFilters): IssuePickMenu {
  const groups = filters.projects.map((project) => ({
    label: project.name,
    options: [
      option(`All of ${project.name}`, 'project', { project: project.id }),
      ...project.milestones.map((milestone) => option(milestone.name, 'milestone', { project: project.id, milestone: milestone.id })),
    ],
  }));
  // A project zone's own project is on the menu even when the tracker no longer lists it as open.
  if (tracker.project !== undefined && !filters.projects.some((project) => project.id === tracker.project)) {
    groups.unshift({ label: "This zone's project", options: [option("All of this zone's project", 'project', { project: tracker.project })] });
  }
  if (filters.milestones.length > 0) {
    groups.push({
      label: 'Milestones',
      options: filters.milestones.map((milestone) => option(milestone.name, 'milestone', { project: null, milestone: milestone.id })),
    });
  }
  return { scope: option(`All of ${tracker.scope}`, 'scope', { project: null }), groups };
}

/** What the picker says about its select: why it is missing (its filters failed), or why it lacks projects. */
export type IssuePickNote = { kind: 'failed'; message: string } | { kind: 'project-scope' } | undefined;

export function issuePickNote(filters: IssueFilters | undefined, failure: string | undefined): IssuePickNote {
  if (failure !== undefined) return { kind: 'failed', message: failure };
  return filters?.missing === 'project-scope' ? { kind: 'project-scope' } : undefined;
}

/** Every choice on the menu, the scope first. */
export function menuOptions(menu: IssuePickMenu): IssuePickOption[] {
  return [menu.scope, ...menu.groups.flatMap((group) => group.options)];
}

const stored = (zoneId: string) => storedValue(`agent-board.issue-pick.${zoneId}`);

/** The pick last chosen in this zone's picker, or undefined if none was or it can't be read. */
export function storedPick(zoneId: string): IssuePick | undefined {
  const raw = stored(zoneId).get();
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { project, milestone } = parsed as Record<string, unknown>;
    if (project !== null && typeof project !== 'string') return undefined;
    if (milestone !== undefined && typeof milestone !== 'string') return undefined;
    return { project, ...(milestone === undefined ? {} : { milestone }) };
  } catch {
    return undefined;
  }
}

/** Remembers the zone's pick for the next time its picker opens. */
export function storePick(zoneId: string, pick: IssuePick): void {
  stored(zoneId).set(pickValue(pick));
}
