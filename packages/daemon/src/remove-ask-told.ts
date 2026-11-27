// What an orchestrator is told of its remove ask: in the answer of the call that waited on it, or, for an ask it left
// (`ask_to_remove`, or a call or turn that ended first), typed at its prompt once the user answers or the wait runs out.
import type { RemoveAsk, RemoveAskResult } from './protocol.ts';
import { minutes } from './plan-told.ts';

/** `a`, `a and b`, `a, b and c`: names in a sentence. */
const andList = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What the orchestrator is told of the user's answer to its remove ask, in words. */
export function removeAskText(result: RemoveAskResult): string {
  const asked = andList([...result.removed, ...result.kept].map((tile) => tile.name));
  const kept = result.kept.map((tile) => `${tile.name} stays: ${tile.why}.`).join(' ');
  if (result.outcome === 'timed-out') return `The user did not answer, so nothing was removed: ask again later, or tell them why.`;
  if (result.outcome === 'denied') {
    return result.kept.every((tile) => tile.why === 'the user denied it')
      ? `The user denied removing ${asked}: nothing was removed.`
      : `Nothing was removed. ${kept}`;
  }
  const removed = result.removed.length === 0 ? 'The user allowed it, but nothing was removed.' : `The user allowed it. Removed ${andList(result.removed.map((tile) => tile.name))}, with their worktrees and branches.`;
  return kept === '' ? removed : `${removed} ${kept}`;
}

/** Typed at the orchestrator's prompt when an ask it left ends: which ask, and how. */
export function removeAskToldText(ask: RemoveAsk, result: RemoveAskResult): string {
  return `The answer to your ask to remove ${andList(ask.tiles.map((tile) => tile.name))}: ${removeAskText(result)}`;
}

/** Typed at the orchestrator's prompt when removing what the user allowed failed, for an ask no call waits on. */
export function removeAskFailedText(ask: RemoveAsk, error: unknown): string {
  return `The user answered your ask to remove ${andList(ask.tiles.map((tile) => tile.name))}, but removing failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Typed at the orchestrator's prompt, once it is resumed, when its session ended with an ask up: the ask ended then. */
export function removeAskEndedText(ask: RemoveAsk): string {
  return `Your ask to remove ${andList(ask.tiles.map((tile) => tile.name))} ended when your session did, unanswered: nothing was removed. Ask again if they should still go.`;
}

/**
 * What the orchestrator is told when no call waits on its ask: it asked without waiting (`waited` false), or the call
 * that waited stopped first, as its next turn began. Either way the ask stays up, and the answer comes as a message.
 */
export function removeAskLeftText(ask: RemoveAsk, waited: boolean): string {
  const names = andList(ask.tiles.map((tile) => tile.name));
  const wait = minutes(Date.parse(ask.expiresAt) - Date.parse(ask.askedAt));
  const head = waited
    ? `Your next turn began before the user answered, so this stopped waiting. The ask to remove ${names} stays up in their Needs you inbox`
    : `Asked the user to remove ${names}, in one Allow/Deny prompt in their Needs you inbox`;
  return (
    `${head}. Nothing waits here: their answer comes to your prompt as a message, with what was removed and what stayed, ` +
    `or, if they don't answer within ${wait}, that nothing was removed. Don't ask again before it comes, unless you can't ` +
    `tell whether it still stands (the board restarted, say, which ends it): asking again is refused while it is up.`
  );
}
