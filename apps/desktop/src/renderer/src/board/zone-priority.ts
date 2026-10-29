// A zone's priority and budget hold as its tab shows them. Pure, so the wording is unit-tested. A daemon from an older
// build sends zones without either field: such a zone reads as Normal and not held.
import { ZONE_PRIORITIES, type UsageHold, type Zone, type ZonePriority } from '@agent-board/daemon/protocol';

/** Each priority's name on a zone's tab and in its menu. */
export const PRIORITY_LABELS: Record<ZonePriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** The zone's priority: Normal from a daemon that keeps none. */
export const zonePriority = (zone: Pick<Zone, 'priority'>): ZonePriority => ((ZONE_PRIORITIES as readonly unknown[]).includes(zone.priority) ? zone.priority : 'normal');

/** The zone's budget hold, or null: none from a daemon that keeps none. */
export const zoneHold = (zone: Pick<Zone, 'usageHold'>): UsageHold | null => {
  const hold: unknown = zone.usageHold;
  return typeof hold === 'object' && hold !== null ? zone.usageHold : null;
};

/** What the zone's priority chip says, and its accessible name and hint. */
export function priorityChip(zone: Pick<Zone, 'priority' | 'usageHold'>): { text: string; label: string; title: string } {
  const label = PRIORITY_LABELS[zonePriority(zone)];
  const hold = zoneHold(zone);
  if (hold === null) return { text: label, label: `Priority: ${label}`, title: 'Its priority, for the usage thresholds in Settings' };
  return { text: `⏳ ${label} · held`, label: `Priority: ${label}, held for usage`, title: `Held: ${hold.reason}. Override from this menu` };
}
