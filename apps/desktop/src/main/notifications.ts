import { BrowserWindow, Notification } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { createAgentAlerts } from './alerts';
import { createAppIcon } from './app-icon';
import { backgroundMode } from './background';
import { answerBanner, bannerOf } from './banner';
import { followAgents } from './follow-agents';
import type { AppNotification } from './notifications-types';

export type { AppNotification };

/**
 * Raises a notification and calls `onClick` when the user clicks it, or `onAnswer` with the index of the answer they
 * pick under its Options (only a question's banner under the Simplified design has any).
 */
export type Notifier = (notification: AppNotification, onClick: () => void, onAnswer?: (index: number) => void) => void;

/** A notification the fake notifier raised, as e2e tests read it from the main process. */
export interface FakeNotification extends AppNotification {
  /** The banner as drawn: its subtitle, and the answers it lists. */
  subtitle?: string;
  answers: string[];
  click(): void;
  answer(index: number): void;
}

declare global {
  /** What the fake notifier raised, oldest first. */
  var agentBoardNotifications: FakeNotification[] | undefined;
}

/**
 * Raises OS notifications. Electron drops a notification's click handler if the object is garbage collected while
 * it shows, so each is kept until it is clicked or closed.
 */
function osNotifier(simplified: () => boolean): Notifier {
  const showing = new Set<Notification>();
  return (raised, onClick, onAnswer) => {
    if (!Notification.isSupported()) return;
    const { title, subtitle, body, answers } = bannerOf(raised, simplified());
    // macOS lists several actions under Options; where they don't render (no alert style, unsigned app) the banner
    // still opens the agent on a click.
    const notification = new Notification({ title, subtitle, body, actions: answers.map((text) => ({ type: 'button', text })) });
    showing.add(notification);
    notification.on('click', () => {
      showing.delete(notification);
      onClick();
    });
    notification.on('action', (_event, index) => {
      showing.delete(notification);
      onAnswer?.(index);
    });
    notification.on('close', () => showing.delete(notification));
    notification.show();
  };
}

/** Keeps notifications on `globalThis.agentBoardNotifications` instead, for tests: they never reach the OS. */
function fakeNotifier(simplified: () => boolean): Notifier {
  const raised: FakeNotification[] = (globalThis.agentBoardNotifications = []);
  return (notification, onClick, onAnswer) => {
    const { title, subtitle, body, answers } = bannerOf(notification, simplified());
    raised.push({ ...notification, title, subtitle, body, answers, click: onClick, answer: (index) => onAnswer?.(index) });
  };
}

/** The OS's notifications, drawn as the current design draws them (`simplified`), or with `AGENT_BOARD_FAKE_NOTIFICATIONS` set, as tests do, ones that are only recorded. */
export function createNotifier(simplified: () => boolean): Notifier {
  return process.env.AGENT_BOARD_FAKE_NOTIFICATIONS ? fakeNotifier(simplified) : osNotifier(simplified);
}

/**
 * Notifies the user through `notify` of each new request in the needs-you inbox (`createAgentAlerts`), and shows the app's
 * state on the dock icon, its badge and the menu bar (`createAppIcon`). Clicking a notification calls `openAgent`, and
 * clicking the menu-bar icon `openBoard`. Picking an answer under a question's Options answers it. Returns the function that stops it.
 */
export function registerNotifications(
  daemon: DaemonLink,
  notify: Notifier,
  openAgent: (sessionId: string) => void,
  openBoard: () => void,
  simplified: () => boolean,
): () => void {
  // Not in e2e runs (background mode): a test's app would leave an icon in the developer's menu bar.
  const appIcon = createAppIcon({ menuBar: !backgroundMode, onClick: openBoard });
  const alerts = createAgentAlerts({
    notify: (notification) =>
      notify(
        notification,
        () => openAgent(notification.sessionId),
        (index) => answerBanner(notification, index, { answer: (params) => daemon.call('ask.answer', params), openAgent }),
      ),
    showState: (status) => appIcon.show(status),
    simplified,
    // A focused window that isn't drawn (an e2e run's, headless) is no board in front of the user.
    inFront: () => BrowserWindow.getFocusedWindow()?.isVisible() === true,
  });
  const stopFollowing = followAgents(daemon, alerts);
  return () => {
    stopFollowing();
    appIcon.stop();
  };
}
