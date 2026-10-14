import { ConfigError } from './hooks.ts';

export interface ParsedArgs {
  /** Each flag's last value. */
  flags: Map<string, string | true>;
  /** Every value of each valued flag, in order (`-c a=1 -c b=2`). */
  values: Map<string, string[]>;
  positionals: string[];
}

export interface FlagSpec {
  /** Flags that take a value (`--flag value` or `--flag=value`). */
  valued: ReadonlySet<string>;
  /** Flags that take none. */
  switches: ReadonlySet<string>;
}

/** Parses the harness's own flags and rejects any it doesn't know, so a test passing a new real flag notices. */
export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const flags = new Map<string, string | true>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (spec.valued.has(name)) {
      let value: string;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length) value = argv[++i]!;
      else throw new ConfigError(`option ${name} needs a value`);
      flags.set(name, value);
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (spec.switches.has(name) && eq < 0) {
      flags.set(name, true);
    } else {
      throw new ConfigError(`unknown option ${arg} (the fake knows: ${[...spec.valued, ...spec.switches].join(' ')})`);
    }
  }
  return { flags, values, positionals };
}

export function stringFlag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => args.flags.has(name));
}

/** Every value given for any of `names`, in order. */
export function listFlag(args: ParsedArgs, ...names: string[]): string[] {
  return names.flatMap((name) => args.values.get(name) ?? []);
}
