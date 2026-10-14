import { useEffect, useState } from 'react';
import { shortIssueId, type TrackerIssue, type Zone } from '@agent-board/daemon/protocol';
import { Search, X } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { ErrorText, Hint, IconButton, Input, Tag } from '../ui';

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
 * Browses the zone's tracker: its open issues, or the issues matching what is typed. Picking one selects it; picking
 * it again, or its × above the list, clears the selection. The selection stays shown above the list, so a search that
 * hides it never hides what was picked.
 */
export function IssuePicker({ zone, selected, onSelect }: IssuePickerProps) {
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<TrackerIssue[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        window.agentBoard.trackers.issues(zone.id, query).then(
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
  }, [zone.id, query]);

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
      <Input
        type="search"
        icon={<Search />}
        aria-label="Search issues"
        placeholder={`Search ${zone.tracker?.scope ?? ''} issues`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
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
