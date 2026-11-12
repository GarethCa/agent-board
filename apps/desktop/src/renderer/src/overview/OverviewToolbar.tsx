import { ArrowUpDown, ChevronDown, Search } from 'lucide-react';
import { Button, Input, Menu } from '../ui';
import { OVERVIEW_FILTER_LABELS, OVERVIEW_FILTERS, type GroupSort, type OverviewFilter, type ProjectSort } from './overview-model';

const GROUP_SORT_LABELS: Record<GroupSort, string> = { waiting: 'Longest waiting first', newest: 'Newest change first', name: 'Name' };
const GROUP_SORT_SHORT: Record<GroupSort, string> = { waiting: 'Longest waiting', newest: 'Newest change', name: 'Name' };
const PROJECT_SORT_LABELS: Record<ProjectSort, string> = { board: 'Board order', 'on-you': 'Most on you first' };

export interface OverviewToolbarProps {
  greeting: string;
  /** "since 18:40 · 41 threads · 6 projects" */
  summary: string;
  query: string;
  onQuery(query: string): void;
  /** How many threads the search found, of how many; shown while searching. */
  found: { shown: number; of: number };
  filter: OverviewFilter;
  counts: Record<OverviewFilter, number>;
  onFilter(filter: OverviewFilter): void;
  groups: GroupSort;
  onGroups(sort: GroupSort): void;
  projects: ProjectSort;
  onProjects(sort: ProjectSort): void;
  onMarkSeen(): void;
}

/** The key to the cards' dots, in the title bar: a solid one the agent set, a dashed one the board's guess. */
export function OverviewLegend() {
  return (
    <p className="overview-legend">
      <span>
        <span className="overview-legend-dot" data-source="agent" aria-hidden="true" /> agent set
      </span>
      <span>
        <span className="overview-legend-dot" data-source="board" aria-hidden="true" /> board’s guess
      </span>
    </p>
  );
}

/** The Overview's toolbar: the greeting, search, the filter, the sort (with the projects' order when it isn't the board's), and Mark all seen. */
export function OverviewToolbar(props: OverviewToolbarProps) {
  const { query, filter, counts, groups, projects } = props;
  return (
    <div className="overview-tools">
      <div className="overview-greeting">
        <b>☀ {props.greeting}</b>
        <span>{props.summary}</span>
      </div>
      <label className="overview-search">
        <Input size="sm" icon={<Search aria-hidden="true" />} type="search" placeholder="Search threads, people, PRs" aria-label="Search threads" value={query} onChange={(event) => props.onQuery(event.currentTarget.value)} />
        {query.trim() === '' ? null : (
          <span className="overview-found" data-testid="overview-found">
            {props.found.shown} of {props.found.of}
          </span>
        )}
      </label>
      <div className="ui-segmented overview-filter" role="group" aria-label="Show">
        {OVERVIEW_FILTERS.map((each) => (
          <button key={each} type="button" aria-pressed={each === filter} onClick={() => props.onFilter(each)}>
            {OVERVIEW_FILTER_LABELS[each]} <span className="overview-count">{counts[each]}</span>
          </button>
        ))}
      </div>
      <Menu
        entries={[
          { heading: 'Sort each group by' },
          ...(Object.keys(GROUP_SORT_LABELS) as GroupSort[]).map((each) => ({ label: GROUP_SORT_LABELS[each], checked: each === groups, onSelect: () => props.onGroups(each) })),
          'separator',
          { heading: 'Projects' },
          ...(Object.keys(PROJECT_SORT_LABELS) as ProjectSort[]).map((each) => ({ label: PROJECT_SORT_LABELS[each], checked: each === projects, onSelect: () => props.onProjects(each) })),
        ]}
      >
        <Button size="sm" variant="ghost" icon={<ArrowUpDown aria-hidden="true" />} trailingIcon={<ChevronDown aria-hidden="true" />}>
          {GROUP_SORT_SHORT[groups]}
          {projects === 'on-you' ? ' · most on you' : ''}
        </Button>
      </Menu>
      <Button size="sm" className="overview-mark-seen" onClick={props.onMarkSeen}>
        Mark all seen
      </Button>
    </div>
  );
}
