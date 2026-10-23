import { BrowserWindow, Notification } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { createAgentAlerts, type AgentNotification } from './alerts';
import { createAppIcon } from './app-icon';
import { backgroundMode } from './background';
import { followAgents } from './follow-agents';

/** What a notification says: about an agent, or about the app itself (no `sessionId`). */
export type AppNotification = Omit<AgentNotification, 'sessionId'> & { sessionId?: string };

/** Raises a notification and calls `onClick` when the user clicks it. */
export type Notifier = (notification: AppNotification, onClick: () => void) => void;

/** A notification the fake notifier raised, as e2e tests read it from the main process. */
export interface FakeNotification extends AppNotification {
  click(): void;
}

declare global {
  /** What the fake notifier raised, oldest first. */
  var agentBoardNotifications: FakeNotification[] | undefined;
}

/**
 * Raises OS notifications. Electron drops a notification's click handler if the object is garbage collected while
 * it shows, so each is kept until it is clicked or closed.
 */
function osNotifier(): Notifier {
  const showing = new Set<Notification>();
  return ({ title, body }, onClick) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    showing.add(notification);
    notification.on('click', () => {
      showing.delete(notification);
      onClick();
    });
    notification.on('close', () => showing.delete(notification));
    notification.show();
  };
}

/** Keeps notifications on `globalThis.agentBoardNotifications` instead, for tests: they never reach the OS. */
function fakeNotifier(): Notifier {
  const raised: FakeNotification[] = (globalThis.agentBoardNotifications = []);
  return (notification, onClick) => raised.push({ ...notification, click: onClick });
}

/** The OS's notifications, or with `AGENT_BOARD_FAKE_NOTIFICATIONS` set, as tests do, ones that are only recorded. */
export function createNotifier(): Notifier {
  return process.env.AGENT_BOARD_FAKE_NOTIFICATIONS ? fakeNotifier() : osNotifier();
}

/**
 * Notifies the user through `notify` of each new request in the needs-you inbox (`createAgentAlerts`), and shows the app's
 * state on the dock icon, its badge and the menu bar (`createAppIcon`). Clicking a notification calls `openAgent`, and
 * clicking the menu-bar icon `openBoard`. Returns the function that stops it.
 */
export function registerNotifications(
  daemon: DaemonLink,
  notify: Notifier,
  openAgent: (sessionId: string) => void,
  openBoard: () => void,
): () => void {
  // Not in e2e runs (background mode): a test's app would leave an icon in the developer's menu bar.
  const appIcon = createAppIcon({ menuBar: !backgroundMode, onClick: openBoard });
  const alerts = createAgentAlerts({
    notify: (notification) => notify(notification, () => openAgent(notification.sessionId)),
    showState: (status) => appIcon.show(status),
    // A focused window that isn't drawn (an e2e run's, headless) is no board in front of the user.
    inFront: () => BrowserWindow.getFocusedWindow()?.isVisible() === true,
  });
  const stopFollowing = followAgents(daemon, alerts);
  return () => {
    stopFollowing();
    appIcon.stop();
  };
}
