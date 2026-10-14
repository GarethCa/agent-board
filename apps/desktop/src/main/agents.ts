import { app, ipcMain, type BrowserWindow } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { AGENT_ERROR, type PermissionDecision, type ScheduleSpec, type SpawnAgentParams, type TileMove } from '@agent-board/daemon/protocol';
import { revealWindow } from './background';
import { AGENT_IPC, type DeleteAgentResult, type RestartAgentResult, type SpawnAgentResult } from '../preload/api';
import { forwardEvents } from './broadcast';
import { handImage } from './image-staging';

/**
 * Test-only: how long the answer to a tile's move is held back, as on a busy machine, where it can reach the
 * board after the daemon's events of later moves. Never in a packaged build.
 */
const moveAnswerDelayMs = app.isPackaged ? 0 : Number(process.env.AGENT_BOARD_MOVE_ANSWER_DELAY_MS ?? 0);

/** The agent IPC the preload's `agents` API calls. Every window hears every agent change, so tiles stay live. */
export function registerAgentIpc(daemon: DaemonLink, dataDir: string): void {
  forwardEvents(daemon, ['agent.updated', 'agent.removed'], AGENT_IPC.changed);

  ipcMain.handle(AGENT_IPC.list, () => daemon.call('agent.list'));
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
  ipcMain.handle(AGENT_IPC.answer, async (_event, sessionId: string, text: string, paste?: boolean) => {
    await daemon.call('agent.answer', { sessionId, text, paste });
  });
  ipcMain.handle(AGENT_IPC.pasteImage, async (_event, bytes: unknown) => (await handImage(dataDir, bytes, (path) => daemon.call('image.paste', { path }))).path);
  ipcMain.handle(AGENT_IPC.transcript, (_event, sessionId: string, since: number, generation?: number) =>
    daemon.call('agent.transcript', { sessionId, since, generation }),
  );
  ipcMain.handle(AGENT_IPC.subagentTranscript, (_event, sessionId: string, toolUseId: string, agentId?: string) =>
    daemon.call('agent.subagentTranscript', { sessionId, toolUseId, agentId }),
  );
  ipcMain.handle(AGENT_IPC.interrupt, (_event, sessionId: string) => daemon.call('agent.interrupt', { sessionId }));
  ipcMain.handle(AGENT_IPC.stop, (_event, sessionId: string) => daemon.call('agent.stop', { sessionId }));
  ipcMain.handle(AGENT_IPC.resume, (_event, sessionId: string) => daemon.call('agent.resume', { sessionId }));
  ipcMain.handle(AGENT_IPC.restart, async (_event, sessionId: string, force: boolean): Promise<RestartAgentResult> => {
    try {
      return { status: 'restarted', agent: await daemon.call('agent.resume', { sessionId, force }) };
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.shellBusy) return { status: 'busy', message: error.message };
      throw error;
    }
  });
  ipcMain.handle(AGENT_IPC.decidePermission, async (_event, sessionId: string, requestId: string, decision: PermissionDecision) => {
    await daemon.call('agent.decidePermission', { sessionId, requestId, ...decision });
  });
  ipcMain.handle(AGENT_IPC.link, (_event, sessionId: string, issueId: string | null) =>
    daemon.call('agent.link', { sessionId, issueId }),
  );
  ipcMain.handle(AGENT_IPC.setSchedule, (_event, sessionId: string, schedule: ScheduleSpec | null) =>
    daemon.call('agent.setSchedule', { sessionId, schedule }),
  );
  ipcMain.handle(AGENT_IPC.setName, (_event, sessionId: string, name: string) =>
    daemon.call('agent.setName', { sessionId, name }),
  );
  ipcMain.handle(AGENT_IPC.setMuted, (_event, sessionId: string, muted: boolean) =>
    daemon.call('agent.setMuted', { sessionId, muted }),
  );
  ipcMain.handle(AGENT_IPC.move, async (_event, sessionId: string, move: TileMove) => {
    const moved = await daemon.call('agent.move', { ...move, sessionId });
    if (moveAnswerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, moveAnswerDelayMs));
    return moved;
  });
  ipcMain.handle(AGENT_IPC.delete, async (_event, sessionId: string, force: boolean): Promise<DeleteAgentResult> => {
    try {
      await daemon.call('agent.delete', { sessionId, force });
      return { status: 'deleted' };
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.unsavedWork) {
        return { status: 'unsaved', message: error.message };
      }
      throw error;
    }
  });
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
