// Checks for RPC params, which arrive untyped off the wire. Each throws an `invalidParams` error naming the bad field.
import { MAX_EDGE_POINTS, MAX_NAME_LENGTH, RPC_ERROR, type EdgePoint } from './protocol.ts';
import { RpcMethodError } from './rpc.ts';

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

/** A name for a tile or pane: trimmed, and no longer than `MAX_NAME_LENGTH`. Empty when blank. */
export function nameParam(params: Record<string, unknown>, name: string): string {
  const value = stringParam(params, name).trim();
  if (value.length > MAX_NAME_LENGTH) throw invalidParams(`${name} must be at most ${MAX_NAME_LENGTH} characters`);
  return value;
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

export function invalidParams(message: string): RpcMethodError {
  return new RpcMethodError(RPC_ERROR.invalidParams, message);
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
    return { x: finiteNumberParam(at, 'x'), y: finiteNumberParam(at, 'y') };
  });
}
