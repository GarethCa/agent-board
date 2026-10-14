// Strips a Linear recording down to what the tests need, so no private data is committed with it: the lists a real
// workspace answers (its teams, open issues, projects) are cut to the team, scratch issue and project under test, and the
// workspace's slug is taken out of every URL. Used by the recorder, and run over a recording already made by
// sanitise-recorded.ts.
import type { HttpInteraction } from '../src/http-fixtures.ts';

export interface LinearRecording {
  source: string;
  subject: { scope: string; knownIssue: { id: string }; project?: string };
  interactions: HttpInteraction[];
}

/** What a workspace's URLs say in place of its slug. */
export const REDACTED_WORKSPACE = 'workspace';
const WORKSPACE_URL = /(https:\/\/linear\.app\/)[^/"\s]+\//g;

type Nodes = { nodes: Record<string, unknown>[] };

/** Cuts the lists in a response's `data` to what the subject is. */
function keepSubject({ subject }: LinearRecording, body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('data' in body)) return body;
  const data = body.data as Record<string, Nodes | unknown> | null;
  if (typeof data !== 'object' || data === null) return body;
  const keep = (name: string, wanted: (node: Record<string, unknown>) => boolean) => {
    const list = data[name] as Nodes | undefined;
    if (list !== undefined && Array.isArray(list.nodes)) list.nodes = list.nodes.filter(wanted);
  };
  keep('teams', (team) => team.key === subject.scope);
  keep('issues', (issue) => issue.identifier === subject.knownIssue.id);
  keep('searchIssues', (issue) => issue.identifier === subject.knownIssue.id);
  keep('projects', (project) => project.id === subject.project);
  return body;
}

/** The recording with only its subject's data in it, and the workspace slug redacted. Changes `recording` itself. */
export function sanitiseRecording<T extends LinearRecording>(recording: T): T {
  for (const { response } of recording.interactions) response.body = keepSubject(recording, response.body);
  return JSON.parse(JSON.stringify(recording).replace(WORKSPACE_URL, `$1${REDACTED_WORKSPACE}/`)) as T;
}

/** Every object in `value`, however deep. */
function objects(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  const own = Array.isArray(value) ? [] : [value as Record<string, unknown>];
  return [...own, ...Object.values(value).flatMap(objects)];
}

/**
 * What in a recording is private, one line each: an issue but the known one, a team but the one under test, a
 * workspace slug in a URL. Empty for a sanitised recording. The fixture tests and the public release's leak check use it.
 */
export function recordingLeaks(text: string): string[] {
  const recording = JSON.parse(text) as LinearRecording;
  const { scope, knownIssue } = recording.subject;
  const all = objects(recording.interactions.map((i) => i.response.body));
  const issues = all.flatMap((o) => (typeof o.identifier === 'string' && o.identifier !== knownIssue.id ? [o.identifier] : []));
  const teams = recording.interactions.flatMap(({ response }) => {
    const data = (response.body as { data?: { teams?: { nodes: { key: string }[] } } } | null)?.data;
    return data?.teams?.nodes.map((team) => team.key).filter((key) => key !== scope) ?? [];
  });
  const slugs = [...text.matchAll(/https:\/\/linear\.app\/([^/"\s]+)\//g)].flatMap((match) => (match[1] === REDACTED_WORKSPACE ? [] : [match[1]]));
  return [
    ...new Set([...issues.map((id) => `issue ${id}`), ...teams.map((key) => `team ${key}`), ...slugs.map((slug) => `workspace slug ${slug}`)]),
  ];
}
