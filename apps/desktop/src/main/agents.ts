import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { AGENT_ERROR, type AskSelectionParams, type PermissionDecision, type ScheduleSpec, type SpawnAgentParams, type TileMove } from '@agent-board/daemon/protocol';
import { revealWindow } from './background';
import { AGENT_IPC, type DeleteAgentResult, type RestartAgentResult, type SpawnAgentResult } from '../preload/api';
import { forwardEvents } from './broadcast';
import { handImage } from './image-staging';
import { passthrough, passthroughVoid } from './passthrough';

/**
 * Test-only: how long the answer to a tile's move is held back, as on a busy machine, where it can reach the
 * board after the daemon's events of later moves. Never in a packaged build.
 */
const moveAnswerDelayMs = app.isPackaged ? 0 : Number(process.env.AGENT_BOARD_MOVE_ANSWER_DELAY_MS ?? 0);

/** The agent IPC the preload's `agents` API calls. Every window hears every agent change, so tiles stay live. */
export function registerAgentIpc(daemon: DaemonLink, dataDir: string): void {
  forwardEvents(daemon, ['agent.updated', 'agent.removed'], AGENT_IPC.changed);

  passthrough(daemon, AGENT_IPC.list, 'agent.list');
  ipcMain.handle(AGENT_IPC.spawn, async (_event, params: SpawnAgentParams): Promise<SpawnAgentResult> => {
    try {
      return { status: 'started', agent: await daemon.call('agent.spawn', params) };
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.projectCodexConfig) {
        return { status: 'confirm', message: error.message };
      }
      throw error;
    }
  });
  ipcMain.handle(AGENT_IPC.nextName, async () => (await daemon.call('agent.nextName')).name);
  passthroughVoid(daemon, AGENT_IPC.answer, 'agent.answer', (sessionId: string, text: string, paste?: boolean) => ({ sessionId, text, paste }));
  ipcMain.handle(AGENT_IPC.pasteImage, async (_event, bytes: unknown) => (await handImage(dataDir, bytes, (path) => daemon.call('image.paste', { path }))).path);
  ipcMain.handle(AGENT_IPC.captureSelection, async (event, rect: unknown, width: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) throw new Error('no window to draw the selection from');
    return stageCapture(dataDir, await window.webContents.capturePage(captureRect(rect)), captureWidth(width));
  });
  passthrough(daemon, AGENT_IPC.askSelection, 'selection.ask', (params: AskSelectionParams) => params);
  passthrough(daemon, AGENT_IPC.transcript, 'agent.transcript', (sessionId: string, since: number, generation?: number) => ({ sessionId, since, generation }));
  passthrough(daemon, AGENT_IPC.subagentTranscript, 'agent.subagentTranscript', (sessionId: string, toolUseId: string, agentId?: string) => ({ sessionId, toolUseId, agentId }));
  passthrough(daemon, AGENT_IPC.interrupt, 'agent.interrupt', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, AGENT_IPC.stop, 'agent.stop', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, AGENT_IPC.resume, 'agent.resume', (sessionId: string) => ({ sessionId }));
  ipcMain.handle(AGENT_IPC.restart, async (_event, sessionId: string, force: boolean): Promise<RestartAgentResult> => {
    try {
      return { status: 'restarted', agent: await daemon.call('agent.resume', { sessionId, force }) };
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.shellBusy) return { status: 'busy', message: error.message };
      throw error;
    }
  });
  passthroughVoid(daemon, AGENT_IPC.decidePermission, 'agent.decidePermission', (sessionId: string, requestId: string, decision: PermissionDecision) => ({ sessionId, requestId, ...decision }));
  passthrough(daemon, AGENT_IPC.link, 'agent.link', (sessionId: string, issueId: string | null) => ({ sessionId, issueId }));
  passthrough(daemon, AGENT_IPC.setSchedule, 'agent.setSchedule', (sessionId: string, schedule: ScheduleSpec | null) => ({ sessionId, schedule }));
  passthrough(daemon, AGENT_IPC.setName, 'agent.setName', (sessionId: string, name: string) => ({ sessionId, name }));
  passthrough(daemon, AGENT_IPC.markSeen, 'agent.markSeen', (sessionId: string) => ({ sessionId }));
  passthrough(daemon, AGENT_IPC.setMuted, 'agent.setMuted', (sessionId: string, muted: boolean) => ({ sessionId, muted }));
  ipcMain.handle(AGENT_IPC.move, async (_event, sessionId: string, move: TileMove) => {
    const moved = await daemon.call('agent.move', { ...move, sessionId });
    if (moveAnswerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, moveAnswerDelayMs));
    return moved;
  });
  ipcMain.handle(AGENT_IPC.delete, async (_event, sessionId: string, force: boolean, keepWorktree: boolean): Promise<DeleteAgentResult> => {
    try {
      await daemon.call('agent.delete', { sessionId, force, keepWorktree });
      return { status: 'deleted' };
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.unsavedWork) {
        return { status: 'unsaved', message: error.message };
      }
      throw error;
    }
  });
}

/** The most a selection's picture is drawn wide, px: enough for a 2× drawing of a large diagram. */
const MAX_CAPTURE_WIDTH = 8192;

/** A capture's box in the window, in whole CSS px. */
function captureRect(rect: unknown): Electron.Rectangle {
  const box = rect as Record<string, unknown>;
  const [x, y, width, height] = [box?.x, box?.y, box?.width, box?.height].map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN));
  if ([x, y, width, height].some(Number.isNaN) || width! < 1 || height! < 1) throw new Error('a capture needs a box in the window');
  return { x: x!, y: y!, width: width!, height: height! };
}

function captureWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1) throw new Error('a capture needs a width');
  return Math.min(MAX_CAPTURE_WIDTH, Math.round(width));
}

/**
 * Writes `image`, drawn `width` px wide, as a PNG where the daemon takes pictures from (`images/incoming`); returns where.
 * The daemon takes it from there, and sweeps it if nothing does.
 */
function stageCapture(dataDir: string, image: Electron.NativeImage, width: number): string {
  if (image.isEmpty()) throw new Error('the window drew nothing to send: is it showing?');
  const incoming = join(dataDir, 'images', 'incoming');
  mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const staged = join(incoming, crypto.randomUUID());
  const drawn = image.getSize().width === width ? image : image.resize({ width, quality: 'best' });
  writeFileSync(staged, drawn.toPNG(), { mode: 0o600 });
  return staged;
}

/**
 * Lets the user open an agent from outside the window (its notification). Returns the function that brings the
 * board's window (from `window`, which makes one if none is open) to the front and opens the agent's session window
 * in it. The request waits in main until the renderer takes it, so a window still loading opens it too.
 */
export function registerAgentOpening(window: () => BrowserWindow): (sessionId: string) => void {
  let request: string | null = null;
  ipcMain.handle(AGENT_IPC.takeOpenRequest, () => {
    const sessionId = request;
    request = null;
    return sessionId;
  });
  return (sessionId) => {
    const target = window();
    revealWindow(target);
    request = sessionId;
    target.webContents.send(AGENT_IPC.openRequested);
  };
}
