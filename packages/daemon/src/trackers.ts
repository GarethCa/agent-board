import type { DatabaseSync } from 'node:sqlite';
import {
  isTrackerProvider,
  TRACKER_PROVIDERS,
  TrackerError,
  type CredentialStore,
  type Tracker,
  type TrackerIssue,
  type TrackerProject,
} from '@agent-board/tracker';
import type { LinkTrackerRef } from './link-metadata.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  TRACKER_ERROR,
  type DaemonMethods,
  type TrackerProvider,
  type TrackerScope,
  type ZoneTracker,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';

/**
 * Makes a provider's tracker: for its stored credential, or with none for a provider that logs in by itself (GitHub,
 * through gh).
 */
export type TrackerFactory = (credential: string | undefined) => Tracker;

export interface TrackerHostOptions {
  db: DatabaseSync;
  /** Where credentials live: the OS keychain outside tests. */
  credentials: CredentialStore;
  /** The providers the daemon offers. */
  providers: Partial<Record<TrackerProvider, TrackerFactory>>;
}

/** An issue to start an agent from, and the branch its tracker names for it. */
export interface IssueForAgent {
  issue: TrackerIssue;
  branch: string;
}

export interface TrackerHost {
  /** Whether there is a credential for it, or, for one that logs in by itself, whether that login works. */
  connected(provider: TrackerProvider): Promise<boolean>;
  /** Checks the credential with the tracker, then stores it. Resolves with the scopes it sees. */
  connect(provider: TrackerProvider, credential: string): Promise<TrackerScope[]>;
  disconnect(provider: TrackerProvider): Promise<void>;
  scopes(provider: TrackerProvider): Promise<TrackerScope[]>;
  /** The zone's tracker, or null if it has none; `invalidParams` for an unknown zone. */
  zoneTracker(zoneId: string): ZoneTracker | null;
  /** The scope's open projects, for a tracker that has them; `invalidParams` for one that has none. */
  projects(provider: TrackerProvider, scope: string): Promise<TrackerProject[]>;
  /**
   * Checks the scope (and its project, if any) exists, so a zone can be bound to it, and resolves with it as the
   * tracker spells it.
   */
  checkScope(tracker: ZoneTracker): Promise<ZoneTracker>;
  /** The zone's open issues (those of its project, if it has one), or those matching `query`. */
  issues(zoneId: string, query?: string): Promise<TrackerIssue[]>;
  /**
   * The issue from the zone's tracker, with its branch name; `invalidParams` if the zone's scope (team) has no such
   * issue.
   */
  issue(zoneId: string, issueId: string): Promise<IssueForAgent>;
  /**
   * An issue or pull request a URL points to, looked up with the tracker; undefined unless a zone is bound to its
   * scope (the configured tracker), or the tracker has no such issue.
   */
  linkTarget(ref: LinkTrackerRef): Promise<{ title: string; state: string } | undefined>;
  /** The labels of an issue in its provider's tracker, or undefined if it has no such issue. */
  issueLabels(issue: { provider: TrackerProvider; id: string }): Promise<string[] | undefined>;
}

interface ZoneTrackerRow {
  tracker_provider: TrackerProvider | null;
  tracker_scope: string | null;
  tracker_project: string | null;
}

/**
 * Talks to the zones' trackers with the credentials in the credential store. A credential is read from the store
 * for each call, never kept or written to the database, so one changed in the keychain takes effect at once.
 */
export function createTrackerHost(options: TrackerHostOptions): TrackerHost {
  const selectZone = options.db.prepare('SELECT tracker_provider, tracker_scope, tracker_project FROM zones WHERE id = ?');

  const selectBound = options.db.prepare(
    'SELECT 1 FROM zones WHERE tracker_provider = ? AND tracker_scope = ? COLLATE NOCASE LIMIT 1',
  );

  const factory = (provider: TrackerProvider): TrackerFactory => {
    const make = options.providers[provider];
    if (make === undefined) throw invalidParams(`no tracker provider ${provider}`);
    return make;
  };

  const tracker = async (provider: TrackerProvider): Promise<Tracker> => {
    const make = factory(provider);
    if (!usesCredential(provider)) return make(undefined);
    const credential = await options.credentials.get(provider);
    if (credential === undefined) {
      throw new RpcMethodError(TRACKER_ERROR.notConnected, `connect ${providerName(provider)} first`);
    }
    return make(credential);
  };

  const zoneTracker = (zoneId: string): ZoneTracker | null => {
    const row = selectZone.get(zoneId) as ZoneTrackerRow | undefined;
    if (row === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (row.tracker_provider === null || row.tracker_scope === null) return null;
    return {
      provider: row.tracker_provider,
      scope: row.tracker_scope,
      ...(row.tracker_project === null ? {} : { project: row.tracker_project }),
    };
  };
  const requiredZoneTracker = (zoneId: string): ZoneTracker => {
    const tracker = zoneTracker(zoneId);
    if (tracker === null) throw invalidParams('the zone has no tracker');
    return tracker;
  };

  return {
    zoneTracker,
    async linkTarget(ref) {
      if (selectBound.get(ref.provider, ref.scope) === undefined) return undefined;
      return call(async () => {
        const client = await tracker(ref.provider);
        if (ref.kind === 'pr') return client.getPullRequest?.(ref.id);
        return client.getIssue(ref.id);
      });
    },
    issueLabels: (issue) =>
      call(async () => {
        const client = await tracker(issue.provider);
        if (client.issueLabels === undefined) throw invalidParams(`${providerName(issue.provider)} can't say an issue's labels`);
        return client.issueLabels(issue.id);
      }),
    async connected(provider) {
      const make = factory(provider);
      if (usesCredential(provider)) return (await options.credentials.get(provider)) !== undefined;
      // Logged in by itself: connected while that login works. Only a refused login says no; an unreachable tracker
      // says nothing about it.
      const client = make(undefined);
      try {
        if (client.loggedIn !== undefined) return await client.loggedIn();
        await client.scopes();
        return true;
      } catch (error) {
        if (error instanceof TrackerError && error.kind === 'unauthorized') return false;
        throw rpcError(error);
      }
    },
    async connect(provider, credential) {
      noCredentialFor(provider);
      const trimmed = credential.trim();
      if (trimmed === '') throw invalidParams('the credential must not be empty');
      const scopes = await call(() => factory(provider)(trimmed).scopes());
      await options.credentials.set(provider, trimmed).catch((error: Error) => {
        throw invalidParams(error.message);
      });
      return scopes;
    },
    async disconnect(provider) {
      factory(provider);
      noCredentialFor(provider);
      await options.credentials.delete(provider);
    },
    scopes: async (provider) => call(async () => (await tracker(provider)).scopes()),
    projects: async (provider, scope) =>
      call(async () => {
        const client = await tracker(provider);
        if (client.projects === undefined) throw invalidParams(`${providerName(provider)} has no projects`);
        return client.projects(scope);
      }),
    async checkScope({ provider, scope, project }) {
      return call(async () => {
        const client = await tracker(provider);
        const found = await client.getScope(scope);
        if (found === undefined) {
          throw invalidParams(`${providerName(provider)} has no ${scope} ${TRACKER_PROVIDERS[provider].seenBy} can see`);
        }
        if (project === undefined) return { provider, scope: found.key };
        if (client.getProject === undefined) throw invalidParams(`${providerName(provider)} has no projects`);
        const inScope = await client.getProject(found.key, project);
        if (inScope === undefined) throw invalidParams(`${found.key} has no project ${project}`);
        return { provider, scope: found.key, project: inScope.id };
      });
    },
    async issues(zoneId, query) {
      const { provider, scope, project } = requiredZoneTracker(zoneId);
      const text = query?.trim() ?? '';
      return call(async () => {
        const client = await tracker(provider);
        return text === '' ? client.listIssues(scope, { project }) : client.searchIssues(scope, text, { project });
      });
    },
    async issue(zoneId, issueId) {
      const { provider, scope } = requiredZoneTracker(zoneId);
      return call(async () => {
        const client = await tracker(provider);
        const issue = await client.getIssue(issueId);
        // The zone's issues are its scope's: an issue from another team is no more its than a missing one.
        if (issue?.scope !== scope) throw invalidParams(`${scope} has no issue ${issueId}`);
        return { issue, branch: client.branchName(issue) };
      });
    },
  };
}

/** Runs a tracker call, turning its `TrackerError`s into RPC errors. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw rpcError(error);
  }
}

/** The RPC error for a `TrackerError`; any other error as it is. */
function rpcError(error: unknown): unknown {
  if (!(error instanceof TrackerError)) return error;
  if (error.kind === 'unauthorized') return new RpcMethodError(TRACKER_ERROR.unauthorized, error.message);
  if (error.kind === 'unavailable') return new RpcMethodError(TRACKER_ERROR.unavailable, error.message);
  return invalidParams(error.message);
}

function providerName(provider: TrackerProvider): string {
  return TRACKER_PROVIDERS[provider].name;
}

/** False for a provider that logs in by itself, such as GitHub through gh. */
function usesCredential(provider: TrackerProvider): boolean {
  return TRACKER_PROVIDERS[provider].auth === 'apiKey';
}

/** Refuses to store or forget a credential for a provider that never has one. */
function noCredentialFor(provider: TrackerProvider): void {
  if (!usesCredential(provider)) {
    const { name, seenBy, loginHelp } = TRACKER_PROVIDERS[provider];
    throw invalidParams(`${name} uses ${seenBy}'s own login and keeps no credential: ${loginHelp}`);
  }
}

type TrackerMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `tracker.${string}`>>;

/** The `tracker.*` RPC handlers. */
export function trackerHandlers<Context>(trackers: TrackerHost): RpcHandlers<TrackerMethods, Context> {
  const provider = (params: unknown) => providerParam(paramsObject(params));
  return {
    'tracker.status': async (params) => {
      const p = provider(params);
      return { provider: p, connected: await trackers.connected(p) };
    },
    'tracker.connect': (params) => trackers.connect(provider(params), stringParam(paramsObject(params), 'credential')),
    'tracker.disconnect': async (params) => {
      await trackers.disconnect(provider(params));
      return null;
    },
    'tracker.scopes': (params) => trackers.scopes(provider(params)),
    'tracker.projects': (params) => {
      const p = paramsObject(params);
      return trackers.projects(providerParam(p), stringParam(p, 'scope'));
    },
    'tracker.issues': (params) => {
      const p = paramsObject(params);
      return trackers.issues(stringParam(p, 'zoneId'), optionalStringParam(p, 'query'));
    },
  };
}

function providerParam(params: Record<string, unknown>): TrackerProvider {
  const value = stringParam(params, 'provider');
  if (!isTrackerProvider(value)) {
    throw invalidParams(`provider must be one of ${Object.keys(TRACKER_PROVIDERS).join(', ')}`);
  }
  return value;
}

/** A zone's tracker from wire params: `{ provider, scope }` or null. */
export function zoneTrackerParam(params: Record<string, unknown>): ZoneTracker | null {
  if (params.tracker === null) return null;
  const tracker = paramsObject(params.tracker);
  const scope = stringParam(tracker, 'scope').trim();
  if (scope === '') throw invalidParams('tracker.scope must not be empty');
  const project = optionalStringParam(tracker, 'project')?.trim();
  return { provider: providerParam(tracker), scope, ...(project ? { project } : {}) };
}
