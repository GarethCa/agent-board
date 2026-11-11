// Folding a zone to a chip while it is not needed (`zone.fold`, `zone.unfold`): the fold itself is one flag on the zone,
// and its agents are paused to free what their harnesses hold. Nothing here pauses an agent later, when a turn that
// was running at the fold ends: what could not pause stays live, and the chip says so. Its shells are left running.
import type { DatabaseSync } from 'node:sqlite';
import type { AgentHost } from './agents.ts';
import { keyedQueue } from './keyed-queue.ts';
import { invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import type { DaemonMethods, Zone, ZoneFoldResult, ZoneUnfoldResult } from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { ZoneTable } from './zones.ts';

type FoldMethods = Pick<DaemonMethods, 'zone.fold' | 'zone.unfold'>;

/** The part of the agents host the fold needs. */
type FoldAgents = Pick<AgentHost, 'list' | 'get' | 'pause' | 'resume'>;

/** Why a pause or a wake was refused, without the agent's name: what a fold or an unfold left carries that beside it. */
const whyOf = (error: unknown): string =>
  error instanceof RpcMethodError && error.reason !== undefined ? error.reason : error instanceof Error ? error.message : String(error);

/** The `zone.fold` and `zone.unfold` handlers. */
export function zoneFoldHandlers<Context>(db: DatabaseSync, zones: ZoneTable, agents: FoldAgents): RpcHandlers<FoldMethods, Context> {
  const setFolded = db.prepare('UPDATE zones SET folded = ? WHERE id = ?');
  // What the zone's fold paused and nothing has woken since (`agents.hibernated_fold`, written with the pause).
  const selectFoldPaused = db.prepare('SELECT session_id FROM agents WHERE hibernated_fold = ? AND hibernated_at IS NOT NULL');
  const forgetFoldPaused = db.prepare('UPDATE agents SET hibernated_fold = NULL WHERE hibernated_fold = ?');
  /** A zone's folds and unfolds one at a time, as asked: neither pauses nor wakes across the other. */
  const inTurn = keyedQueue();
  const known = (id: string): Zone => {
    const zone = zones.find(id);
    if (zone === undefined) throw invalidParams(`no zone ${id}`);
    return zone;
  };
  const inZone = (id: string) => agents.list().filter((agent) => agent.zoneId === id);
  return {
    'zone.fold': async (params) => {
      const id = stringParam(paramsObject(params), 'id');
      known(id);
      return inTurn(id, async () => {
        const zone = known(id);
        // A fold of a folded zone pauses nothing again.
        if (zone.folded) return { zone, paused: [], kept: [] };
        // Its chip would hide how far the clone is, and what a failed one says.
        if (zone.clone !== null) throw invalidParams(`${zone.name} is still cloning: fold it once its clone is done`);
        // Folded first, so the chip is up whatever a pause does.
        setFolded.run(1, id);
        zones.announce(id);
        const paused: string[] = [];
        const kept: ZoneFoldResult['kept'] = [];
        for (const { sessionId } of inZone(id)) {
          // Each pause takes a while: read again, as its zone may be removed by now, and it deleted, moved out or ended.
          if (zones.find(id)?.folded !== true) break;
          const agent = agents.get(sessionId);
          // One already paused, or ended, has nothing running to free.
          if (agent === undefined || agent.zoneId !== id || agent.endedAt !== null) continue;
          try {
            await agents.pause(sessionId, null, 'folding its zone', id);
            paused.push(sessionId);
          } catch (error) {
            kept.push({ sessionId, name: agent.name, why: whyOf(error) });
          }
        }
        return { zone: zones.find(id) ?? { ...zone, folded: true }, paused, kept };
      });
    },
    'zone.unfold': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const wake = optionalBooleanParam(fields, 'wake') === true;
      known(id);
      return inTurn(id, async () => {
        const zone = known(id);
        // An unfold of a zone that is not folded wakes nothing: whatever is paused in it, no fold paused.
        if (!zone.folded) return { zone, woken: [], asleep: [] };
        setFolded.run(0, id);
        // Asked to wake or not, what stays paused from here on is paused as if by hand: a later unfold wakes none of it.
        const foldPaused = new Set(selectFoldPaused.all(id).map((row) => row.session_id as string));
        forgetFoldPaused.run(id);
        zones.announce(id);
        const woken: string[] = [];
        const asleep: ZoneUnfoldResult['asleep'] = [];
        if (wake) {
          for (const { sessionId } of inZone(id).filter((each) => foldPaused.has(each.sessionId))) {
            // Each wake takes a while: read again, as it may be deleted, moved out or woken by now.
            const agent = agents.get(sessionId);
            if (agent === undefined || agent.zoneId !== id || agent.state !== 'hibernated') continue;
            // One that won't wake stops none of the rest: the zone is unfolded either way.
            try {
              await agents.resume(sessionId, 'unfolding its zone', false);
              woken.push(sessionId);
            } catch (error) {
              asleep.push({ sessionId, name: agent.name, why: whyOf(error) });
            }
          }
        }
        return { zone: zones.find(id) ?? { ...zone, folded: false }, woken, asleep };
      });
    },
  };
}
