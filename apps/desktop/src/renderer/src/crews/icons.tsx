import { Bot, Eye, Hammer, Network, PenLine, RefreshCw, Search, Users, Zap } from 'lucide-react';
import { ORCHESTRATOR_ROLE, type PrefabMember } from '@agent-board/daemon/protocol';

/**
 * A member's icon, by its role, as its tile's role badge draws it: a design reviewer (its name or id says so) gets an
 * eye, so two reviewers tell apart at a glance.
 */
export function RoleIcon({ member }: { member: Pick<PrefabMember, 'id' | 'name' | 'role'> }) {
  const { role } = member;
  if (role === 'implementer') return <Hammer aria-hidden />;
  if (role === 'reviewer') return /design/i.test(`${member.name ?? ''} ${member.id}`) ? <Eye aria-hidden /> : <Search aria-hidden />;
  if (role === 'follow-up-reviewer') return <RefreshCw aria-hidden />;
  if (role === ORCHESTRATOR_ROLE) return <Network aria-hidden />;
  return <PenLine aria-hidden />;
}

/** A prefab's own icon, by its name in the file (`agent`, `review`, `spike`, `lead`, `crew`). */
export function PrefabIcon({ icon }: { icon: string }) {
  if (icon === 'agent') return <Bot aria-hidden />;
  if (icon === 'review') return <Search aria-hidden />;
  if (icon === 'spike') return <Zap aria-hidden />;
  if (icon === 'lead') return <Network aria-hidden />;
  return <Users aria-hidden />;
}
