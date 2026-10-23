import type { DaemonLink } from '@agent-board/daemon/client';
import type { AgentAlerts } from './alerts';

/** What following the agents needs of the daemon link. */
export type FollowedLink = Pick<DaemonLink, 'call' | 'onEvent' | 'onConnected' | 'onDisconnected'>;

/** How long to wait before each retry after a drop or a failed listing; the last is repeated. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Keeps `alerts` on the daemon's agents and settings: every `agent.*` and `settings.updated` event, and a full listing
 * (with the settings) on every new connection, since
 * events pushed while disconnected are lost. After a drop, or a listing that failed, it lists again after a delay,
 * which reconnects the link (starting the daemon if it is gone), so the badge recovers without anything else calling.
 * Returns the function that stops it.
 */
export function followAgents(link: FollowedLink, alerts: AgentAlerts, retryDelaysMs = RETRY_DELAYS_MS): () => void {
  let stopped = false;
  let listing = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const later = () => {
    if (stopped || retry !== undefined) return;
    const delay = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)]!;
    failures++;
    retry = setTimeout(() => {
      retry = undefined;
      list();
    }, delay);
  };

  /** Lists the agents, unless a listing is in flight: one sent on a new connection covers every event since. */
  const list = () => {
    if (stopped || listing) return;
    clearTimeout(retry);
    retry = undefined;
    listing = true;
    Promise.all([link.call('agent.list'), link.call('settings.get')]).then(
      ([agents, settings]) => {
        listing = false;
        failures = 0;
        if (!stopped) alerts.reset(agents, settings);
      },
      () => {
        listing = false;
        later();
      },
    );
  };

  const unsubscribe = [
    link.onEvent((event) => {
      if (event.type === 'agent.updated') alerts.updated(event.agent);
      else if (event.type === 'agent.removed') alerts.removed(event.sessionId);
      else if (event.type === 'settings.updated') alerts.settingsChanged(event.settings);
    }),
    link.onConnected(list),
    link.onDisconnected(later),
  ];
  list();

  return () => {
    stopped = true;
    clearTimeout(retry);
    for (const off of unsubscribe) off();
  };
}
