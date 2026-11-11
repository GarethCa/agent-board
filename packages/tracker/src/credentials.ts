import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Secrets by account (`linear`), kept outside the database. */
export interface CredentialStore {
  get(account: string): Promise<string | undefined>;
  /** Replaces any secret the account had. */
  set(account: string, secret: string): Promise<void>;
  /** Forgets the account's secret, if it has one. */
  delete(account: string): Promise<void>;
}

/** The keychain service agent-board's items are filed under. */
export const KEYCHAIN_SERVICE = 'agent-board';

/**
 * Characters a secret may have. API keys and OAuth tokens fit, and nothing here needs quoting in `security -i`'s
 * command language or is a line end. (Length is checked on the whole command: see `MAX_COMMAND_LENGTH`.)
 */
const SECRET_PATTERN = /^[A-Za-z0-9._~+/=:-]{1,4096}$/;

/**
 * Characters an account name may have: a provider (`linear`), maybe with a host or user. Like the secret, it goes
 * into `security -i`'s command language, and nothing here needs quoting there or is a line end. It starts with a
 * letter or digit, so no tool reads it as an option.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/** A keychain path goes inside double quotes in `security -i`, so it may not hold one, a backslash or a line end. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses.
const UNSAFE_PATH = /["\\\x00-\x1f\x7f]/;

/**
 * The longest command we hand `security -i`, in bytes with its newline. It cuts every 4095 characters into a command
 * of its own, so a longer line would run its first piece without the keychain file, writing to the login keychain,
 * and run the rest as a second command. This leaves headroom below that.
 */
const MAX_COMMAND_LENGTH = 4000;

export interface KeychainOptions {
  /**
   * The keychain file to use instead of the user's default (login) keychain, for tests. macOS only; must exist.
   * Elsewhere, naming one keeps the store away from the user's own: it stores nothing.
   */
  keychain?: string;
  platform?: NodeJS.Platform;
}

/**
 * The OS keychain: the macOS keychain through `security`, or the Secret Service (GNOME Keyring, KWallet) through
 * `secret-tool` on Linux. Secrets go to the tool on stdin, never on its command line, where `ps` would show them.
 * Windows' Credential Manager is not supported yet.
 */
export function createKeychainStore(options: KeychainOptions = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return macKeychain(options.keychain);
  // The Secret Service can't be pointed at a file, so a test that names one must never reach the user's.
  if (options.keychain !== undefined) return noStore('keychain files are macOS-only');
  if (platform === 'linux') return secretService();
  return noStore(`storing credentials is not supported on ${platform} yet`);
}

/** A store that has nothing and refuses to store anything, saying `why`. */
function noStore(why: string): CredentialStore {
  return {
    get: async () => undefined,
    set: () => Promise.reject(new Error(why)),
    delete: async () => {},
  };
}

function macKeychain(keychain?: string): CredentialStore {
  const file = keychain === undefined ? [] : [keychain];
  const security = (args: string[], input?: string) => {
    // `security` quietly falls back to the login keychain when the named file is missing.
    if (keychain !== undefined && !existsSync(keychain)) {
      return Promise.reject(new Error(`no keychain at ${keychain}`));
    }
    return run('security', args, input);
  };
  return {
    async get(account) {
      const found = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', ...file]);
      // 44: errSecItemNotFound.
      if (found.code === 44) return undefined;
      if (found.code !== 0) throw new Error(`could not read the keychain: ${found.stderr}`);
      return found.stdout.replace(/\n$/, '');
    },
    async set(account, secret) {
      checkAccount(account);
      checkSecret(secret);
      if (keychain !== undefined && UNSAFE_PATH.test(keychain)) throw new Error('that is not a safe keychain path');
      // `security -i` reads commands on stdin, so the secret never reaches a command line.
      const quoted = [KEYCHAIN_SERVICE, account, secret, ...file].map((word) => `"${word}"`);
      const command = `add-generic-password -U -s ${quoted[0]} -a ${quoted[1]} -l ${quoted[0]} -w ${quoted.slice(2).join(' ')}\n`;
      if (Buffer.byteLength(command) > MAX_COMMAND_LENGTH) throw new Error('that is too long to store');
      const added = await security(['-i'], command);
      // `security -i` exits 0 even when a command fails, so check the write took. Its stderr is left out of the error:
      // it could echo the command, secret and all.
      if (added.code !== 0 || (await this.get(account)) !== secret) throw new Error('could not write to the keychain');
    },
    async delete(account) {
      const deleted = await security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, ...file]);
      if (deleted.code !== 0 && deleted.code !== 44)
        throw new Error(`could not delete from the keychain: ${deleted.stderr}`);
    },
  };
}

function secretService(): CredentialStore {
  const attributes = (account: string) => ['service', KEYCHAIN_SERVICE, 'account', account];
  return {
    // An account that isn't valid was never stored, and `secret-tool` might read one as an option.
    async get(account) {
      if (!ACCOUNT_PATTERN.test(account)) return undefined;
      const found = await run('secret-tool', ['lookup', ...attributes(account)]);
      return found.code === 0 && found.stdout !== '' ? found.stdout : undefined;
    },
    async set(account, secret) {
      checkAccount(account);
      checkSecret(secret);
      const stored = await run(
        'secret-tool',
        ['store', `--label=agent-board ${account}`, ...attributes(account)],
        secret,
      );
      if (stored.code !== 0) throw new Error(`could not write to the Secret Service: ${stored.stderr}`);
    },
    async delete(account) {
      if (!ACCOUNT_PATTERN.test(account)) return;
      await run('secret-tool', ['clear', ...attributes(account)]);
    },
  };
}

function checkAccount(account: string): void {
  if (!ACCOUNT_PATTERN.test(account)) throw new Error('that is not a valid account name');
}

function checkSecret(secret: string): void {
  if (!SECRET_PATTERN.test(secret)) throw new Error('that does not look like an API key or token');
}

/** Runs a tool, feeding it `input`. Resolves with its exit code and output; rejects only if it can't be started. */
function run(command: string, args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new Error(`${command} was not found`));
      else resolve({ code: child.exitCode ?? 1, stdout, stderr: stderr.trim() });
    });
    // A tool that exits without reading its input makes the write fail with EPIPE; its exit status says what happened.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** A store that keeps secrets in memory, for tests. */
export function createMemoryCredentialStore(): CredentialStore & { readonly secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    secrets,
    get: async (account) => secrets.get(account),
    set: async (account, secret) => void secrets.set(account, secret),
    delete: async (account) => void secrets.delete(account),
  };
}
