import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  AGENT_IPC,
  APPEARANCE_IPC,
  CONNECTOR_IPC,
  FLOW_EDGE_IPC,
  REVIEW_IPC,
  ORCHESTRATOR_IPC,
  DAEMON_IPC,
  EXTERNAL_IPC,
  ITEM_IPC,
  SESSION_IPC,
  SETUP_IPC,
  SHELL_IPC,
  TRACKER_IPC,
  VIEW_IPC,
  WINDOW_IPC,
  WINDOW_QUERY,
  ZONE_IPC,
  windowChrome,
  type AgentBoardApi,
  type SessionStreamEvent,
} from './api';
import { appearanceFrom } from '../shared/appearance';
import { ipcErrorMessage } from '../shared/errors';
import { ipcCalls } from './ipc';

const { invoke, subscribe } = ipcCalls(ipcRenderer);

const api: AgentBoardApi = {
  daemonHealth: () => invoke(DAEMON_IPC.health),
  build: () => invoke(DAEMON_IPC.build),
  restartDaemon: (force) => invoke(DAEMON_IPC.restart, force),
  sessions: {
    list: () => invoke(SESSION_IPC.list),
    attach(sessionId, onEvent) {
      const attachId = crypto.randomUUID();
      const listener = (_event: IpcRendererEvent, id: string, streamEvent: SessionStreamEvent) => {
        if (id === attachId) onEvent(streamEvent);
      };
      ipcRenderer.on(SESSION_IPC.event, listener);
      ipcRenderer.invoke(SESSION_IPC.attach, sessionId, attachId).catch((error: unknown) => {
        ipcRenderer.off(SESSION_IPC.event, listener);
        onEvent({ type: 'session.attachFailed', sessionId, message: ipcErrorMessage(error) });
      });
      return () => {
        ipcRenderer.off(SESSION_IPC.event, listener);
        void ipcRenderer.invoke(SESSION_IPC.detach, attachId);
      };
    },
    write: (sessionId, data) => ipcRenderer.send(SESSION_IPC.write, sessionId, data),
    resize: (sessionId, size) => invoke(SESSION_IPC.resize, sessionId, size),
    kill: (sessionId) => invoke(SESSION_IPC.kill, sessionId),
    cwd: (sessionId) => invoke(SESSION_IPC.cwd, sessionId),
    openFolder: (path) => invoke(SESSION_IPC.openFolder, path),
    onExited: (listener) => subscribe(SESSION_IPC.exited, listener),
  },
  zones: {
    list: () => invoke(ZONE_IPC.list),
    add: (params) => invoke(ZONE_IPC.add, params),
    addFolder: (path, params) => invoke(ZONE_IPC.addFolder, path, params),
    addUnbound: (params) => invoke(ZONE_IPC.addUnbound, params),
    clone: (repo, params) => invoke(ZONE_IPC.clone, repo, params),
    cancelClone: (id) => invoke(ZONE_IPC.cancelClone, id),
    recentFolders: () => invoke(ZONE_IPC.recentFolders),
    githubRepos: () => invoke(ZONE_IPC.githubRepos),
    bind: (id, as) => invoke(ZONE_IPC.bind, id, as),
    update: (id, layout) => invoke(ZONE_IPC.update, id, layout),
    configure: (id, settings) => invoke(ZONE_IPC.configure, id, settings),
    setTracker: (id, tracker) => invoke(ZONE_IPC.setTracker, id, tracker),
    unbind: (id) => invoke(ZONE_IPC.unbind, id),
    setDefaultRepo: (id, path) => invoke(ZONE_IPC.setDefaultRepo, id, path),
    setLook: (id, look) => invoke(ZONE_IPC.setLook, id, look),
    dissolve: (id) => invoke(ZONE_IPC.dissolve, id),
    restore: (zone) => invoke(ZONE_IPC.restore, zone),
    browseFolder: (title) => invoke(ZONE_IPC.browseFolder, title),
    onChanged: (listener) => subscribe(ZONE_IPC.changed, listener),
  },
  items: {
    list: () => invoke(ITEM_IPC.list),
    create: (params) => invoke(ITEM_IPC.create, params),
    update: (params) => invoke(ITEM_IPC.update, params),
    delete: (id) => invoke(ITEM_IPC.delete, id),
    importImage: (bytes) => invoke(ITEM_IPC.importImage, bytes),
    onChanged: (listener) => subscribe(ITEM_IPC.changed, listener),
  },
  connectors: {
    list: () => invoke(CONNECTOR_IPC.list),
    create: (params) => invoke(CONNECTOR_IPC.create, params),
    update: (params) => invoke(CONNECTOR_IPC.update, params),
    delete: (id) => invoke(CONNECTOR_IPC.delete, id),
    onChanged: (listener) => subscribe(CONNECTOR_IPC.changed, listener),
  },
  flowEdges: {
    list: () => invoke(FLOW_EDGE_IPC.list),
    create: (params) => invoke(FLOW_EDGE_IPC.create, params),
    update: (params) => invoke(FLOW_EDGE_IPC.update, params),
    preview: (id) => invoke(FLOW_EDGE_IPC.preview, id),
    lastPayload: (id) => invoke(FLOW_EDGE_IPC.lastPayload, id),
    commands: (id) => invoke(FLOW_EDGE_IPC.commands, id),
    approve: (id, command, fingerprint) => invoke(FLOW_EDGE_IPC.approve, id, command, fingerprint),
    drop: (id) => invoke(FLOW_EDGE_IPC.drop, id),
    settings: () => invoke(FLOW_EDGE_IPC.settings),
    setSettings: (settings) => invoke(FLOW_EDGE_IPC.setSettings, settings),
    send: (id) => invoke(FLOW_EDGE_IPC.send, id),
    delete: (id) => invoke(FLOW_EDGE_IPC.delete, id),
    onChanged: (listener) => subscribe(FLOW_EDGE_IPC.changed, listener),
  },
  reviews: {
    list: () => invoke(REVIEW_IPC.list),
    start: (sessionId) => invoke(REVIEW_IPC.start, sessionId),
    send: (id) => invoke(REVIEW_IPC.send, id),
    dismiss: (id) => invoke(REVIEW_IPC.dismiss, id),
    merge: (id) => invoke(REVIEW_IPC.merge, id),
    setCap: (sessionId, cap) => invoke(REVIEW_IPC.setCap, sessionId, cap),
    onChanged: (listener) => subscribe(REVIEW_IPC.changed, listener),
  },
  orchestrators: {
    activity: (orchestratorId, before) => invoke(ORCHESTRATOR_IPC.activity, orchestratorId, before),
    onLogged: (listener) => subscribe(ORCHESTRATOR_IPC.logged, listener),
  },
  agents: {
    list: () => invoke(AGENT_IPC.list),
    spawn: (params) => invoke(AGENT_IPC.spawn, params),
    nextName: () => invoke(AGENT_IPC.nextName),
    delete: (sessionId, force = false, keepWorktree = false) => invoke(AGENT_IPC.delete, sessionId, force, keepWorktree),
    answer: (sessionId, text, paste = false) => invoke(AGENT_IPC.answer, sessionId, text, paste),
    pasteImage: (bytes) => invoke(AGENT_IPC.pasteImage, bytes),
    transcript: (sessionId, since, generation) => invoke(AGENT_IPC.transcript, sessionId, since, generation),
    subagentTranscript: (sessionId, toolUseId, agentId) => invoke(AGENT_IPC.subagentTranscript, sessionId, toolUseId, agentId),
    interrupt: (sessionId) => invoke(AGENT_IPC.interrupt, sessionId),
    stop: (sessionId) => invoke(AGENT_IPC.stop, sessionId),
    resume: (sessionId) => invoke(AGENT_IPC.resume, sessionId),
    restart: (sessionId, force = false) => invoke(AGENT_IPC.restart, sessionId, force),
    decidePermission: (sessionId, requestId, decision) => invoke(AGENT_IPC.decidePermission, sessionId, requestId, decision),
    link: (sessionId, issueId) => invoke(AGENT_IPC.link, sessionId, issueId),
    setSchedule: (sessionId, schedule) => invoke(AGENT_IPC.setSchedule, sessionId, schedule),
    markSeen: (sessionId) => invoke(AGENT_IPC.markSeen, sessionId),
    setMuted: (sessionId, muted) => invoke(AGENT_IPC.setMuted, sessionId, muted),
    setName: (sessionId, name) => invoke(AGENT_IPC.setName, sessionId, name),
    move: (sessionId, move) => invoke(AGENT_IPC.move, sessionId, move),
    onChanged: (listener) => subscribe(AGENT_IPC.changed, listener),
    onOpenRequested(listener) {
      // Taken on every poke and once on subscribing, for a request made before this window listened. Taking is
      // one-shot in main, so a request is never delivered twice.
      const take = () =>
        void ipcRenderer.invoke(AGENT_IPC.takeOpenRequest).then((sessionId: string | null) => {
          if (sessionId !== null) listener(sessionId);
        });
      const unsubscribe = subscribe(AGENT_IPC.openRequested, take);
      take();
      return unsubscribe;
    },
  },
  shells: {
    list: () => invoke(SHELL_IPC.list),
    createTab: (owner, options) => invoke(SHELL_IPC.createTab, owner, options),
    ownTab: (agentId) => invoke(SHELL_IPC.ownTab, agentId),
    scripts: (owner) => invoke(SHELL_IPC.scripts, owner),
    create: (params) => invoke(SHELL_IPC.create, params),
    split: (shellId, sessionId, direction, cwd) => invoke(SHELL_IPC.split, shellId, sessionId, direction, cwd),
    resizeSplit: (shellId, splitId, ratio) => invoke(SHELL_IPC.resizeSplit, shellId, splitId, ratio),
    closePane: (shellId, sessionId) => invoke(SHELL_IPC.closePane, shellId, sessionId),
    closeOwnPanes: (shellId) => invoke(SHELL_IPC.closeOwnPanes, shellId),
    resumePane: (shellId, sessionId) => invoke(SHELL_IPC.resumePane, shellId, sessionId),
    delete: (shellId) => invoke(SHELL_IPC.delete, shellId),
    setName: (shellId, name) => invoke(SHELL_IPC.setName, shellId, name),
    setPaneName: (shellId, sessionId, name) => invoke(SHELL_IPC.setPaneName, shellId, sessionId, name),
    move: (shellId, move) => invoke(SHELL_IPC.move, shellId, move),
    moveTab: (shellId, to, order) => invoke(SHELL_IPC.moveTab, shellId, to, order),
    movePane: (shellId, sessionId, to, id) => invoke(SHELL_IPC.movePane, shellId, sessionId, to, id),
    returnPane: (shellId, sessionId, layout) => invoke(SHELL_IPC.returnPane, shellId, sessionId, layout),
    windowLayout: (owner) => invoke(SHELL_IPC.windowLayout, owner),
    setWindowLayout: (owner, layout) => invoke(SHELL_IPC.setWindowLayout, owner, layout),
    unsplitTabs: (owner) => invoke(SHELL_IPC.unsplitTabs, owner),
    onChanged: (listener) => subscribe(SHELL_IPC.changed, listener),
  },
  external: {
    list: () => invoke(EXTERNAL_IPC.list),
    dismiss: (id) => invoke(EXTERNAL_IPC.dismiss, id),
    move: (id, move) => invoke(EXTERNAL_IPC.move, id, move),
    resumePlan: (id) => invoke(EXTERNAL_IPC.resumePlan, id),
    resume: (id, where, options) => invoke(EXTERNAL_IPC.resume, id, where, options),
    hooksStatus: () => invoke(EXTERNAL_IPC.hooksStatus),
    setHooksEnabled: (enabled) => invoke(EXTERNAL_IPC.setHooksEnabled, enabled),
    onChanged: (listener) => subscribe(EXTERNAL_IPC.changed, listener),
  },
  trackers: {
    status: (provider) => invoke(TRACKER_IPC.status, provider),
    connect: (provider, credential) => invoke(TRACKER_IPC.connect, provider, credential),
    disconnect: (provider) => invoke(TRACKER_IPC.disconnect, provider),
    scopes: (provider) => invoke(TRACKER_IPC.scopes, provider),
    projects: (provider, scope) => invoke(TRACKER_IPC.projects, provider, scope),
    issues: (zoneId, query) => invoke(TRACKER_IPC.issues, zoneId, query),
    openLink: (url) => invoke(TRACKER_IPC.openLink, url),
  },
  view: {
    get: (key) => invoke(VIEW_IPC.get, key),
    set: (key, value) => invoke(VIEW_IPC.set, key, value),
  },
  appearance: {
    initial: appearanceFrom(new URLSearchParams(location.search).get(WINDOW_QUERY.appearance)),
    get: () => invoke(APPEARANCE_IPC.get),
    set: (appearance) => invoke(APPEARANCE_IPC.set, appearance),
    onChanged: (listener) => subscribe(APPEARANCE_IPC.changed, listener),
  },
  setup: {
    check: (tool) => invoke(SETUP_IPC.check, tool),
    testNotification: () => invoke(SETUP_IPC.testNotification),
    installCli: () => invoke(SETUP_IPC.installCli),
    onGettingStarted(listener) {
      // Taken on every poke and once on subscribing, as opening an agent is, for a request made while the board loaded.
      const take = () =>
        void ipcRenderer.invoke(SETUP_IPC.takeGettingStarted).then((requested: boolean) => {
          if (requested) listener();
        });
      const unsubscribe = subscribe(SETUP_IPC.gettingStarted, take);
      take();
      return unsubscribe;
    },
  },
  windows: {
    popOut: (target, options) => invoke(WINDOW_IPC.popOut, target, options?.reveal ?? true),
    popIn: (id) => invoke(WINDOW_IPC.popIn, id),
    close: (id) => invoke(WINDOW_IPC.close, id),
    onReturned: (listener) => subscribe(WINDOW_IPC.returned, listener),
    chrome: windowChrome(process.platform),
    isFullScreen: () => invoke(WINDOW_IPC.isFullScreen),
    onFullScreenChanged: (listener) => subscribe(WINDOW_IPC.fullScreen, listener),
  },
};

contextBridge.exposeInMainWorld('agentBoard', api);
