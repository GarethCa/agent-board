import type { ReactNode } from 'react';
import { Activity as ActivityIcon, FileCheck, LayoutDashboard } from 'lucide-react';
import { ACTIVITY_TAB, BOARD_TAB, type PopUpView } from '../agent-popup';

/** A view's icon, on its tab, its row in the sidebar and its icon on the rail. */
export function viewIcon(key: PopUpView['key']): ReactNode {
  return key === BOARD_TAB ? <LayoutDashboard /> : key === ACTIVITY_TAB ? <ActivityIcon /> : <FileCheck />;
}
