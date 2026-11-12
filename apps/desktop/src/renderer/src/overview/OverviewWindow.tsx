import { useEffect, useMemo, useState } from 'react';
import type { Agent, NeedsYouShows, Zone } from '@agent-board/daemon/protocol';
import { useNeedsYouShows } from '../needs-you-setting';
import { useLiveLists } from '../windows/use-live-lists';
import { filterCounts, overviewColumns, overviewThreads, type GroupSort, type OverviewFilter, type ProjectSort, when } from './overview-model';
import { OverviewLegend, OverviewToolbar } from './OverviewToolbar';
import { ProjectColumn } from './ProjectColumn';

const MINUTE = 60_000;

/** The Overview window: the board's agents and zones, kept live, and the last look, which main keeps. */
export function OverviewWindow() {
  const { agents, zones, listed } = useLiveLists();
  const shows = useNeedsYouShows();
  const [seenAt, setSeenAt] = useState<string>();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    void window.agentBoard.overview.seen().then(setSeenAt, (error: unknown) => {
      console.error('agent-board: could not read the Overview’s last look:', error);
      setSeenAt(new Date().toISOString());
    });
    // The ages and "since" read the clock: a minute is as fine as they go.
    const tick = window.setInterval(() => setNow(new Date()), MINUTE);
    return () => window.clearInterval(tick);
  }, []);

  // Until the lists and the last look are in, a blank window: an empty board's message would flash first.
  if (seenAt === undefined || !listed) return <div className="overview-window" />;
  return (
    <OverviewView
      agents={agents}
      zones={zones}
      shows={shows}
      seenAt={seenAt}
      now={now}
      onMarkSeen={() => void window.agentBoard.overview.markSeen().then(setSeenAt, (error: unknown) => console.error('agent-board: could not mark the Overview seen:', error))}
    />
  );
}

export interface OverviewViewProps {
  agents: readonly Agent[];
  zones: readonly Zone[];
  shows: NeedsYouShows;
  seenAt: string;
  now: Date;
  onMarkSeen(): void;
}

/**
 * Every agent on the board at a glance: a column per project, its threads grouped by work category in the seven's
 * order, so what is on the user reads first. The toolbar searches, filters to a group and sorts.
 */
export function OverviewView({ agents, zones, shows, seenAt, now, onMarkSeen }: OverviewViewProps) {
  const [filter, setFilter] = useState<OverviewFilter>('all');
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<GroupSort>('waiting');
  // Board order holds still: columns that moved by themselves would pull the eye from the card being read.
  const [projects, setProjects] = useState<ProjectSort>('board');

  const threads = useMemo(() => overviewThreads(agents, { shows, seenAt }), [agents, shows, seenAt]);
  const counts = useMemo(() => filterCounts(threads), [threads]);
  const columns = useMemo(() => overviewColumns(threads, zones, { filter, query, groups, projects }), [threads, zones, filter, query, groups, projects]);
  const shown = columns.reduce((sum, column) => sum + column.groups.reduce((inColumn, group) => inColumn + group.threads.length, 0), 0);
  const projectCount = new Set(threads.flatMap((thread) => (thread.zoneId !== null && zones.some((zone) => zone.id === thread.zoneId) ? [thread.zoneId] : []))).size;

  return (
    <div className="overview-window" data-testid="overview-window">
      <header className="overview-bar" data-drag-region>
        <h1 className="overview-title">Overview · agent-board</h1>
        <div className="overview-bar-end">
          <OverviewLegend />
          <span className="overview-live">Live</span>
        </div>
      </header>
      <OverviewToolbar
        greeting={greeting(now)}
        summary={`since ${when(new Date(seenAt), now)} · ${plural(threads.length, 'thread')} · ${plural(projectCount, 'project')}`}
        query={query}
        onQuery={setQuery}
        found={{ shown, of: counts[filter] }}
        filter={filter}
        counts={counts}
        onFilter={setFilter}
        groups={groups}
        onGroups={setGroups}
        projects={projects}
        onProjects={setProjects}
        onMarkSeen={onMarkSeen}
      />
      {columns.length === 0 ? (
        <p className="overview-empty">{threads.length === 0 ? 'No agents on the board yet.' : 'Nothing matches.'}</p>
      ) : (
        <main className="overview-columns">
          {columns.map((column) => (
            <ProjectColumn key={column.id ?? ''} column={column} now={now} seenAt={seenAt} />
          ))}
        </main>
      )}
    </div>
  );
}

function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
