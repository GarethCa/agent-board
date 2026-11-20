// Checks for RPC params, which arrive untyped off the wire. Each throws an `invalidParams` error naming the bad field.
import { MAX_EDGE_POINTS, MAX_NAME_LENGTH, RPC_ERROR, type EdgePoint, type WorkCategorySet } from './protocol.ts';
import { RpcMethodError } from './rpc.ts';
import { parseCharacter, type CharacterSet } from './character.ts';
import { parseWorkCategorySet } from './work-category.ts';

/** Largest terminal dimension accepted, in cells. */
const MAX_DIMENSION = 1_000;

export function paramsObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw invalidParams('params must be an object');
  return params as Record<string, unknown>;
}

export function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw invalidParams(`${name} must be a string`);
  return value;
}

/** `text` without its control characters (C0, DEL and C1), which a terminal acts on rather than shows. */
const withoutControls = (text: string): string =>
  [...text]
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('');

/** What marks a line typed at a prompt as the board's own: its `[agent-board]` lead, and the sender mark's brackets. */
const BOARD_MARKS = /^\s*\[agent-board\]|[⟨⟩]/i;

/**
 * `text` as a tile's name may be, never refused: one line with its runs of white space as one space, no control
 * characters, no sender-mark brackets and no `[agent-board]` lead, trimmed. Names are typed into other agents' prompts
 * (a crew member's flag, a reply's trailer), where any of these could make one pass for the board's own words.
 */
function foldedName(text: string): string {
  return withoutControls(text.replace(/\s+/g, ' '))
    .replace(/[⟨⟩]/g, '')
    .replace(/^\s*(\[agent-board\]\s*)+/i, '')
    .trim();
}

/** Text as one line with no control characters in it: what an agent's description may be. */
export function plainLine(text: string): string {
  return withoutControls(text.replace(/\s+/g, ' ')).trim();
}

/**
 * A name for a tile or pane: one line, its white space folded and its control characters dropped (`foldedName`), and no
 * longer than `MAX_NAME_LENGTH`. Empty when blank. One with the board's own marks in it is refused.
 */
export function nameParam(params: Record<string, unknown>, name: string): string {
  const value = cleanName(stringParam(params, name), name);
  if (value.length > MAX_NAME_LENGTH) throw invalidParams(`${name} must be at most ${MAX_NAME_LENGTH} characters`);
  return value;
}

/** `text` as `nameParam` cleans it, uncapped; refused when it holds the board's own marks. */
function cleanName(text: string, name: string): string {
  if (BOARD_MARKS.test(text)) throw invalidParams(`${name} must not hold ⟨ or ⟩ or start with [agent-board]: those mark the board's own lines`);
  return foldedName(text);
}

/** A new agent's name as it is asked for, or undefined: cleaned as `nameParam` cleans one, and cut to fit later, not refused. */
export function startNameParam(params: Record<string, unknown>, name: string): string | undefined {
  return params[name] === undefined ? undefined : cleanName(stringParam(params, name), name);
}

/** A name that must not be blank. */
export function requiredNameParam(params: Record<string, unknown>, name: string): string {
  const value = nameParam(params, name);
  if (value === '') throw invalidParams(`${name} must not be empty`);
  return value;
}

export function optionalStringParam(params: Record<string, unknown>, name: string): string | undefined {
  return params[name] === undefined ? undefined : stringParam(params, name);
}

/** An agent's character set (`board.setStatus`), if given: a pose from its list, and a face and a prop from theirs. */
export function optionalCharacterParam(params: Record<string, unknown>): CharacterSet | undefined {
  if (params.character === undefined) return undefined;
  try {
    return parseCharacter(params.character);
  } catch (error) {
    throw invalidParams((error as Error).message);
  }
}

/** An agent's work category set (`board.setStatus`), if given: `category`, with a `label` and a `waitingOn` if it gave them. */
export function optionalWorkCategoryParam(params: Record<string, unknown>): WorkCategorySet | undefined {
  try {
    return parseWorkCategorySet({ category: params.category, label: params.label, waitingOn: params.waitingOn });
  } catch (error) {
    throw invalidParams((error as Error).message);
  }
}

export function optionalBooleanParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value !== undefined && typeof value !== 'boolean') throw invalidParams(`${name} must be a boolean`);
  return value;
}

/** A whole number from 0, if given. */
export function optionalCountParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) throw invalidParams(`${name} must be a whole number from 0`);
  return value as number | undefined;
}

/** A number that is not NaN or infinite, such as a board coordinate. */
export function finiteNumberParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`${name} must be a finite number`);
  return value;
}

/** A terminal's width or height in cells. */
export function dimensionParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_DIMENSION) {
    throw invalidParams(`${name} must be a whole number from 1 to ${MAX_DIMENSION}`);
  }
  return value as number;
}

export function invalidParams(message: string, reason?: string): RpcMethodError {
  return new RpcMethodError(RPC_ERROR.invalidParams, message, reason);
}

/** An id a client may pick for what it creates (a connector, a flow edge): letters, digits and -, at most 64. */
export const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Field `name`, which must be one of `options`. */
export function oneOf<T extends string>(fields: Record<string, unknown>, name: string, options: readonly T[]): T {
  const value = fields[name];
  if (!options.includes(value as T)) throw invalidParams(`${name} must be one of ${options.join(', ')}`);
  return value as T;
}

/** Field `name`: the bends of a line, each a finite board position, at most `MAX_EDGE_POINTS`. */
export function pointsParam(fields: Record<string, unknown>, name: string): EdgePoint[] {
  const value = fields[name];
  if (!Array.isArray(value)) throw invalidParams(`${name} must be a list`);
  if (value.length > MAX_EDGE_POINTS) throw invalidParams(`a line bends at most ${MAX_EDGE_POINTS} times`);
  return value.map((point: unknown) => {
    const at = paramsObject(point);
    const kept: EdgePoint = { x: finiteNumberParam(at, 'x'), y: finiteNumberParam(at, 'y') };
    if (at.bow !== undefined && at.bow !== true) throw invalidParams(`a point's bow is true or not given`);
    return at.bow === true ? { ...kept, bow: true } : kept;
  });
}
