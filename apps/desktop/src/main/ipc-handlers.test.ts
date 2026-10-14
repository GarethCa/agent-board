import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLink } from '@agent-board/daemon/client';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  webContents: { getAllWebContents: () => [] },
  net: {},
  protocol: {},
  shell: {},
  BrowserWindow: class {},
  dialog: {},
}));

const { registerAgentIpc } = await import('./agents');
const { registerConnectorIpc } = await import('./connectors');
const { registerExternalIpc } = await import('./external');
const { registerFlowEdgeIpc } = await import('./flow-edges');
const { registerItemIpc } = await import('./items');
const { registerOrchestratorIpc } = await import('./orchestrators');
const { registerReviewIpc } = await import('./reviews');
const { registerShellIpc } = await import('./shells');
const { registerTrackerIpc } = await import('./trackers');

/** A daemon that answers every call with `{ method, params }`, so a handler's daemon call can be read back. */
function fakeDaemon(): DaemonLink {
  return {
    call: async (method: string, params?: unknown) => ({ method, params }),
    onEvent: () => () => undefined,
  } as unknown as DaemonLink;
}

function registered(register: (daemon: DaemonLink) => void): string[] {
  handlers.clear();
  register(fakeDaemon());
  return [...handlers.keys()].sort();
}

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

describe('the channels main handles', () => {
  beforeEach(() => handlers.clear());

  it.each([
    ['agents', (d: DaemonLink) => registerAgentIpc(d, '/data'), ['agent:answer', 'agent:decidePermission', 'agent:delete', 'agent:interrupt', 'agent:link', 'agent:list', 'agent:markSeen', 'agent:move', 'agent:nextName', 'agent:pasteImage', 'agent:restart', 'agent:resume', 'agent:setMuted', 'agent:setName', 'agent:setSchedule', 'agent:spawn', 'agent:stop', 'agent:subagentTranscript', 'agent:transcript']],
    ['connectors', registerConnectorIpc, ['connector:create', 'connector:delete', 'connector:list', 'connector:update']],
    ['external', registerExternalIpc, ['external:dismiss', 'external:hooksStatus', 'external:list', 'external:move', 'external:resume', 'external:resumePlan', 'external:setHooksEnabled']],
    ['flow edges', registerFlowEdgeIpc, ['flow-edge:approve', 'flow-edge:commands', 'flow-edge:create', 'flow-edge:delete', 'flow-edge:drop', 'flow-edge:lastPayload', 'flow-edge:list', 'flow-edge:preview', 'flow-edge:send', 'flow-edge:setSettings', 'flow-edge:settings', 'flow-edge:update']],
    ['items', (d: DaemonLink) => registerItemIpc(d, '/data'), ['item:create', 'item:delete', 'item:import-image', 'item:list', 'item:update']],
    ['orchestrators', registerOrchestratorIpc, ['orchestrator:activity']],
    ['reviews', registerReviewIpc, ['review:dismiss', 'review:list', 'review:merge', 'review:send', 'review:set-cap', 'review:start']],
    ['shells', registerShellIpc, ['shell:closeOwnPanes', 'shell:closePane', 'shell:create', 'shell:createTab', 'shell:delete', 'shell:list', 'shell:move', 'shell:movePane', 'shell:moveTab', 'shell:ownTab', 'shell:resizeSplit', 'shell:resumePane', 'shell:returnPane', 'shell:scripts', 'shell:setName', 'shell:setPaneName', 'shell:setWindowLayout', 'shell:split', 'shell:unsplitTabs', 'shell:windowLayout']],
    ['trackers', registerTrackerIpc, ['tracker:connect', 'tracker:disconnect', 'tracker:issues', 'tracker:openLink', 'tracker:projects', 'tracker:scopes', 'tracker:status']],
  ])('%s', (_name, register, channels) => {
    expect(registered(register)).toEqual(channels);
  });
});

describe('what a pass-through sends the daemon', () => {
  it('reshapes positional arguments into the daemon params', async () => {
    registered(registerShellIpc);
    expect(await invoke('shell:split', 's1', 'p1', 'right')).toEqual({ method: 'shell.split', params: { shellId: 's1', sessionId: 'p1', direction: 'right' } });
    expect(await invoke('shell:split', 's1', 'p1', 'right', '/x')).toEqual({ method: 'shell.split', params: { shellId: 's1', sessionId: 'p1', direction: 'right', cwd: '/x' } });
    expect(await invoke('shell:move', 's1', { x: 1 })).toEqual({ method: 'shell.move', params: { x: 1, shellId: 's1' } });
    expect(await invoke('shell:moveTab', 's1', 'to')).toEqual({ method: 'shell.moveTab', params: { shellId: 's1', to: 'to' } });
    expect(await invoke('shell:list')).toEqual({ method: 'shell.list', params: undefined });
    expect(await invoke('shell:windowLayout', { kind: 'agent', id: 'a' })).toEqual({ method: 'shell.windowLayout', params: { owner: { kind: 'agent', id: 'a' } } });
    expect(await invoke('shell:unsplitTabs', { kind: 'agent', id: 'a' })).toEqual({ method: 'shell.unsplitTabs', params: { owner: { kind: 'agent', id: 'a' } } });
    expect(await invoke('shell:setWindowLayout', { kind: 'shell', id: 't' }, 'layout')).toEqual({ method: 'shell.setWindowLayout', params: { owner: { kind: 'shell', id: 't' }, layout: 'layout' } });
    expect(await invoke('shell:closeOwnPanes', 't')).toEqual({ method: 'shell.closeOwnPanes', params: { shellId: 't' } });
  });

  it('answers undefined, not the daemon result, where the API returns void', async () => {
    registered(registerShellIpc);
    expect(await invoke('shell:delete', 's1')).toBeUndefined();
    registered(registerConnectorIpc);
    expect(await invoke('connector:delete', 'c1')).toBeUndefined();
    expect(await invoke('connector:update', { id: 'c1' })).toEqual({ method: 'connector.update', params: { id: 'c1' } });
  });

  it('passes the flow edge settings through the settings methods', async () => {
    registered(registerFlowEdgeIpc);
    expect(await invoke('flow-edge:settings')).toEqual({ method: 'settings.get', params: undefined });
    expect(await invoke('flow-edge:approve', 'e', 'cmd', 'fp')).toEqual({ method: 'flowEdge.approve', params: { id: 'e', command: 'cmd', fingerprint: 'fp' } });
  });
});
