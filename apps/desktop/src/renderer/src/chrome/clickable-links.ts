import type { Agent, DaemonSettings } from '@agent-board/daemon/protocol';

/** What the clickable links switch shows, from the daemon's settings as far as they are read. */
export interface ClickableLinksView {
  /** Whether the switch is drawn on. */
  checked: boolean;
  /** Whether a `FORCE_HYPERLINK` the user set in their environment decides it, so the switch can't change anything. */
  locked: boolean;
}

type LinkSettings = Pick<DaemonSettings, 'clickableLinks' | 'clickableLinksFromEnvironment'>;

/** The switch for `settings`, undefined until they are read: on by default, and the user's own variable wins. */
export function clickableLinksView(settings: LinkSettings | undefined): ClickableLinksView {
  const own = settings?.clickableLinksFromEnvironment ?? null;
  if (own !== null) return { checked: own, locked: true };
  return { checked: settings?.clickableLinks ?? true, locked: false };
}

/**
 * The live Claude agents this daemon started the other way from the switch, which a restart would change. None while the
 * user's own variable decides it: a restart would start them just as they are. Worked out afresh from the agents each
 * time, so the offer is there again whenever Settings opens.
 */
export function startedOtherwise(agents: Iterable<Agent>, settings: LinkSettings | undefined): Agent[] {
  if (settings === undefined || settings.clickableLinksFromEnvironment !== null) return [];
  return [...agents].filter(
    (agent) => agent.harness === 'claude' && agent.endedAt === null && agent.clickableLinks !== null && agent.clickableLinks !== settings.clickableLinks,
  );
}
