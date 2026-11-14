import { useEffect, useMemo, useState } from 'react';
import { shortIssueId, type IssueFilters, type IssuePick, type TrackerIssue, type Zone } from '@agent-board/daemon/protocol';
import { Search, TriangleAlert, X } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { ErrorText, Hint, IconButton, Input, Select, Tag } from '../ui';
import { defaultPick, issuePickMenu, issuePickNote, menuOptions, pickValue, storedPick, storePick } from './issue-pick';

/** How long typing pauses before the tracker is searched. */
const SEARCH_DELAY_MS = 250;

/** An issue as the picker shows it picked: one from the list, or one an issue card names. */
export type PickedIssue = Pick<TrackerIssue, 'provider' | 'id' | 'title'>;

interface IssuePickerProps {
  zone: Zone;
  selected: PickedIssue | undefined;
  onSelect(issue: TrackerIssue | undefined): void;
}

/**
 * Browses the zone's tracker: its open issues, or the issues matching what is typed, in the project or milestone
 * chosen beside the search (remembered per zone; a project zone starts on its own project). Picking one selects it; picking
 * it again, or its × above the list, clears the selection. The selection stays shown above the list, so a search that
 * hides it never hides what was picked.
 */
export function IssuePicker({ zone, selected, onSelect }: IssuePickerProps) {
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<TrackerIssue[]>();
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<IssueFilters>();
  const [filtersError, setFiltersError] = useState<string>();
  const [chosen, setChosen] = useState<IssuePick | undefined>(() => storedPick(zone.id));
  const menu = useMemo(() => (zone.tracker && filters ? issuePickMenu(zone.tracker, filters) : undefined), [zone.tracker, filters]);
  const fallback = zone.tracker ? defaultPick(zone.tracker) : {};
  // A remembered pick the tracker no longer offers (a closed project) gives way to the zone's default.
  const pick =
    chosen === undefined || (menu !== undefined && !menuOptions(menu).some((option) => option.value === pickValue(chosen))) ? fallback : chosen;
  const pickKey = pickValue(pick);
  const note = issuePickNote(filters, filtersError);

  useEffect(() => {
    let cancelled = false;
    // Without filters the picker still lists and searches the whole scope; only the select is missing, and it says why.
    window.agentBoard.trackers.issueFilters(zone.id).then(
      (found) => {
        if (cancelled) return;
        setFilters(found);
        setFiltersError(undefined);
      },
      (failure: unknown) => {
        if (cancelled) return;
        console.warn('the issue picker could not load its projects', failure);
        setFilters({ projects: [], milestones: [] });
        setFiltersError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [zone.id]);

  // A new pick clears the last one's list, so nothing is picked from a list that is not what the select says.
  useEffect(() => setIssues(undefined), [pickKey]);

  // The first list waits for the filters, so a remembered pick they no longer offer is never sent.
  const filtersLoaded = filters !== undefined;
  useEffect(() => {
    if (!filtersLoaded) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        window.agentBoard.trackers.issues(zone.id, query, JSON.parse(pickKey) as IssuePick).then(
          (found) => {
            if (cancelled) return;
            setIssues(found);
            setError(undefined);
          },
          (failure: unknown) => {
            if (!cancelled) setError(errorMessage(failure));
          },
        );
      },
      query === '' ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [zone.id, query, pickKey, filtersLoaded]);

  const choose = (value: string) => {
    const option = menu && menuOptions(menu).find((candidate) => candidate.value === value);
    if (option === undefined) return;
    setChosen(option.pick);
    storePick(zone.id, option.pick);
  };

  return (
    <div className="issue-picker">
      {selected !== undefined && (
        <p className="issue-picker-selected" data-testid="selected-issue">
          <Tag tone="accent" mono>
            {shortIssueId(selected)}
          </Tag>
          <span className="issue-picker-title">{selected.title}</span>
          <IconButton icon={<X />} size="sm" aria-label={`Clear ${selected.id}`} onClick={() => onSelect(undefined)} />
        </p>
      )}
      <div className="issue-picker-bar">
        <Input
          type="search"
          icon={<Search />}
          aria-label="Search issues"
          placeholder={`Search ${zone.tracker?.scope ?? ''} issues`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {menu !== undefined && menu.groups.length > 0 && (
          <Select className="issue-picker-filter" aria-label="Project or milestone" value={pickKey} onChange={(event) => choose(event.target.value)}>
            <option value={menu.scope.value}>{menu.scope.label}</option>
            {menu.groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
      </div>
      {note?.kind === 'failed' && (
        <Hint className="ui-hint-warning" data-testid="issue-filters-error">
          <TriangleAlert aria-hidden /> Couldn't load projects: {note.message}
        </Hint>
      )}
      {note?.kind === 'project-scope' && (
        <Hint className="ui-hint-warning">
          <TriangleAlert aria-hidden /> GitHub Projects need gh's project access: run <code>gh auth refresh -s read:project</code>,
          then reopen this. Until then, milestones only.
        </Hint>
      )}
      {error !== undefined ? (
        <ErrorText>{error}</ErrorText>
      ) : issues === undefined ? (
        <Hint>Loading issues…</Hint>
      ) : issues.length === 0 ? (
        <Hint>No issues found</Hint>
      ) : (
        <ul className="issue-picker-list" role="listbox" aria-label="Issues">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className="issue-picker-option"
              role="option"
              aria-selected={selected?.id === issue.id}
              tabIndex={0}
              title={issue.title}
              onClick={() => onSelect(selected?.id === issue.id ? undefined : issue)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(selected?.id === issue.id ? undefined : issue);
              }}
            >
              <span className="issue-picker-id">{shortIssueId(issue)}</span>
              <span className="issue-picker-title">{issue.title}</span>
              <span className="issue-picker-state">{issue.state}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
