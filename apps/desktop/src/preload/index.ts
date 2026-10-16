import { contextBridge, ipcRenderer } from 'electron';
import {
  AGENT_IPC,
  APPEARANCE_IPC,
  CONNECTOR_IPC,
  FLOW_EDGE_IPC,
  PULL_REQUEST_IPC,
  GATE_IPC,
  ASK_IPC,
  WEB_TAB_IPC,
  REVIEW_IPC,
  ORCHESTRATOR_IPC,
  DAEMON_IPC,
  EXTERNAL_IPC,
  ITEM_IPC,
  SESSION_IPC,
  SETUP_IPC,
  SHELL_IPC,
  TAB_DRAG_IPC,
  TRACKER_IPC,
  VIEW_IPC,
  WINDOW_IPC,
  WINDOW_QUERY,
  ZONE_IPC,
  windowChrome,
  type AgentBoardApi,
  type SessionStreamEvent,
  type BoardRequest,
  type TabDrag,
  type WebTabKey,
  type WebTabState,
} from './api';
import { appearanceFrom } from '../shared/appearance';
import { ipcErrorMessage } from '../shared/errors';
import { ipcCalls } from './ipc';

const { invoke, subscribe, keyed } = ipcCalls(ipcRenderer);
const sessionEvents = keyed<[SessionStreamEvent]>(SESSION_IPC.event);
const webTabStates = keyed<[WebTabState]>(WEB_TAB_IPC.changed);
const webTabKeys = keyed<[WebTabKey]>(WEB_TAB_IPC.key);

const api: AgentBoardApi = {
  daemonHealth: () => invoke(DAEMON_IPC.health),
  build: () => invoke(DAEMON_IPC.build),
  restartDaemon: (force) => invoke(DAEMON_IPC.restart, force),
  sessions: {
    list: () => invoke(SESSION_IPC.list),
    attach(sessionId, onEvent) {
      const attachId = crypto.randomUUID();
      const stop = sessionEvents(attachId, onEvent);
      ipcRenderer.invoke(SESSION_IPC.attach, sessionId, attachId).catch((error: unknown) => {
        stop();
        onEvent({ type: 'session.attachFailed', sessionId, message: ipcErrorMessage(error) });
      });
      return () => {
        stop();
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
    checkFolder: (path, repo) => invoke(ZONE_IPC.checkFolder, path, repo),
    findCopies: () => invoke(ZONE_IPC.findCopies),
    bind: (id, as) => invoke(ZONE_IPC.bind, id, as),
    update: (id, layout) => invoke(ZONE_IPC.update, id, layout),
    configure: (id, settings) => invoke(ZONE_IPC.configure, id, settings),
    setTracker: (id, tracker) => invoke(ZONE_IPC.setTracker, id, tracker),
    unbind: (id) => invoke(ZONE_IPC.unbind, id),
    setDefaultRepo: (id, path) => invoke(ZONE_IPC.setDefaultRepo, id, path),
    roleTemplates: (id) => invoke(ZONE_IPC.roleTemplates, id),
    setRoleTemplate: (id, role, body) => invoke(ZONE_IPC.setRoleTemplate, id, role, body),
    resetRoleTemplate: (id, role) => invoke(ZONE_IPC.resetRoleTemplate, id, role),
    setLook: (id, look) => invoke(ZONE_IPC.setLook, id, look),
    dissolve: (id, options) => invoke(ZONE_IPC.dissolve, id, options),
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
    approve: (id, command, fingerprint, from) => invoke(FLOW_EDGE_IPC.approve, id, command, fingerprint, from),
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
  pullRequests: {
    details: (ref) => invoke(PULL_REQUEST_IPC.details, ref),
    approve: (ref, headCommit) => invoke(PULL_REQUEST_IPC.approve, ref, headCommit),
    merge: (ref, headCommit, pastGate) => invoke(PULL_REQUEST_IPC.merge, ref, headCommit, pastGate),
  },
  gates: {
    list: () => invoke(GATE_IPC.list),
    status: (sessionId) => invoke(GATE_IPC.status, sessionId),
    run: (sessionId) => invoke(GATE_IPC.run, sessionId),
    stop: (sessionId) => invoke(GATE_IPC.stop, sessionId),
    log: (sessionId, step, since) => invoke(GATE_IPC.log, sessionId, step, since),
    sendFailure: (sessionId, step) => invoke(GATE_IPC.sendFailure, sessionId, step),
    merge: (sessionId, number, headCommit, cleanup) => invoke(GATE_IPC.merge, sessionId, number, headCommit, cleanup),
    onChanged: (listener) => subscribe(GATE_IPC.changed, listener),
  },
  asks: {
    answer: (sessionId, askId, answer) => invoke(ASK_IPC.answer, sessionId, askId, answer),
    plans: (sessionId) => invoke(ASK_IPC.plans, sessionId),
    decide: (sessionId, planId, outcome, comments) => invoke(ASK_IPC.decide, sessionId, planId, outcome, comments),
  },
  webTabs: {
    open(tabId, url, { onState, onKey }) {
      const stopStates = webTabStates(tabId, onState);
      const stopKeys = webTabKeys(tabId, onKey);
      ipcRenderer.invoke(WEB_TAB_IPC.open, tabId, url).catch((error: unknown) => onState({ url, title: '', canGoBack: false, canGoForward: false, loading: false, focused: false, problem: ipcErrorMessage(error) }));
      return () => {
        stopStates();
        stopKeys();
        void ipcRenderer.invoke(WEB_TAB_IPC.close, tabId);
      };
    },
    openPlan(tabId, html, { onState, onKey }) {
      const stopStates = webTabStates(tabId, onState);
      const stopKeys = webTabKeys(tabId, onKey);
      ipcRenderer.invoke(WEB_TAB_IPC.openPlan, tabId, html).catch((error: unknown) => onState({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false, focused: false, problem: ipcErrorMessage(error) }));
      return () => {
        stopStates();
        stopKeys();
        void ipcRenderer.invoke(WEB_TAB_IPC.close, tabId);
      };
    },
    setBounds: (tabId, bounds) => ipcRenderer.send(WEB_TAB_IPC.setBounds, tabId, bounds),
    load: (tabId, url) => invoke(WEB_TAB_IPC.load, tabId, url),
    back: (tabId) => invoke(WEB_TAB_IPC.back, tabId),
    forward: (tabId) => invoke(WEB_TAB_IPC.forward, tabId),
    reload: (tabId) => invoke(WEB_TAB_IPC.reload, tabId),
    openInBrowser: (tabId) => invoke(WEB_TAB_IPC.openInBrowser, tabId),
    openOffered: (tabId, shown) => invoke(WEB_TAB_IPC.openOffered, tabId, shown),
    dismissOffered: (tabId) => invoke(WEB_TAB_IPC.dismissOffered, tabId),
    forget: (tabId) => invoke(WEB_TAB_IPC.forget, tabId),
    handOff: (tabId) => invoke(WEB_TAB_IPC.handOff, tabId),
    focus: (tabId) => invoke(WEB_TAB_IPC.focus, tabId),
    cancelHandOff: (tabId) => invoke(WEB_TAB_IPC.cancelHandOff, tabId),
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
    captureSelection: (rect, width) => invoke(AGENT_IPC.captureSelection, rect, width),
    askSelection: (params) => invoke(AGENT_IPC.askSelection, params),
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
    setWindowLayout: (owner, layout, base) => invoke(SHELL_IPC.setWindowLayout, owner, layout, base),
    unsplitTabs: (owner) => invoke(SHELL_IPC.unsplitTabs, owner),
    moveSurface: (surface, from, to) => invoke(SHELL_IPC.moveSurface, surface, from, to),
    forgetWindow: (owner, layout) => invoke(SHELL_IPC.forgetWindow, owner, layout),
    tabWindows: () => invoke(SHELL_IPC.tabWindows),
    onChanged: (listener) => subscribe(SHELL_IPC.changed, listener),
    onWindowLayout: (listener) => subscribe(SHELL_IPC.layoutChanged, listener),
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
    popOut: (target, options) => invoke(WINDOW_IPC.popOut, target, options?.reveal ?? true, options?.at),
    popIn: (id) => invoke(WINDOW_IPC.popIn, id),
    close: (id) => invoke(WINDOW_IPC.close, id),
    onReturned: (listener) => subscribe(WINDOW_IPC.returned, listener),
    switchPopOut: (target) => invoke(WINDOW_IPC.switchPopOut, target),
    onSwitched: (listener) => subscribe(WINDOW_IPC.switched, listener),
    requestBoard: (request) => invoke(WINDOW_IPC.boardRequest, request),
    onBoardRequested(listener) {
      // As agents' open requests: taken on every poke and once on subscribing, for one made while the board was opening.
      const take = () =>
        void ipcRenderer.invoke(WINDOW_IPC.takeBoardRequest).then((request: BoardRequest | null) => {
          if (request !== null) listener(request);
        });
      const unsubscribe = subscribe(WINDOW_IPC.boardRequested, take);
      take();
      return unsubscribe;
    },
    chrome: windowChrome(process.platform),
    isFullScreen: () => invoke(WINDOW_IPC.isFullScreen),
    onFullScreenChanged: (listener) => subscribe(WINDOW_IPC.fullScreen, listener),
  },
  tabDrags: {
    // Fire and forget: a notice lost with main going away changes nothing.
    set: (drag) => void invoke(TAB_DRAG_IPC.set, drag ?? null).catch(() => {}),
    onChanged: (listener) => subscribe(TAB_DRAG_IPC.changed, (drag: TabDrag | null) => listener(drag ?? undefined)),
    untaken: (drag, at) => invoke(TAB_DRAG_IPC.untaken, drag, at),
    move: (move) => invoke(TAB_DRAG_IPC.move, move),
    history: (action) => invoke(TAB_DRAG_IPC.history, action),
    settled: () => void invoke(TAB_DRAG_IPC.settled).catch(() => {}),
    onSettled: (listener) => subscribe(TAB_DRAG_IPC.settledAll, listener),
    ready: () => void invoke(TAB_DRAG_IPC.ready).catch(() => {}),
    onMakeMove: (listener) => subscribe(TAB_DRAG_IPC.makeMove, listener),
    onPopOut: (listener) => subscribe(TAB_DRAG_IPC.popOut, listener),
    onReplay: (listener) => subscribe(TAB_DRAG_IPC.replay, listener),
  },
};

contextBridge.exposeInMainWorld('agentBoard', api);
