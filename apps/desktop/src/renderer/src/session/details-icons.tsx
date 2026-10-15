import type { ReactNode } from 'react';
import {
  Bot,
  CalendarClock,
  CircleDot,
  Columns2,
  FileText,
  FolderGit2,
  GitPullRequest,
  OctagonX,
  Rows2,
  ShieldCheck,
  SquareX,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ControlId } from './controls';

/** The details' sections that have an icon, which the icon rail opens the strip at. */
export type SectionId = 'controls' | 'panes' | 'issue' | 'worktree' | 'pulls' | 'gate' | 'subagents' | 'schedule' | 'status';

/**
 * The one place the details' icons are chosen: the icon rail draws them as buttons, and the expanded strip draws the
 * same ones before its section headings and action rows, so the two views read as one design.
 */
const SECTION_COMPONENTS: Partial<Record<SectionId, LucideIcon>> = {
  issue: CircleDot,
  worktree: FolderGit2,
  pulls: GitPullRequest,
  gate: ShieldCheck,
  subagents: Bot,
  schedule: CalendarClock,
  status: FileText,
};

/** A section's icon, for the rail's buttons, the strip's headings and the rows under them. */
export function SectionIcon({ id, className }: { id: SectionId; className?: string }) {
  const Icon = SECTION_COMPONENTS[id];
  return Icon && <Icon className={className} />;
}

export const CONTROL_ICONS: Record<ControlId, ReactNode> = {
  interrupt: <Zap />,
  stop: <OctagonX />,
};

export const PANE_ICONS = {
  splitHorizontally: <Columns2 />,
  splitVertically: <Rows2 />,
  closePane: <SquareX />,
};
