// Signing the packaged macOS app with a certificate of the user's own, made once on this Mac by `pnpm signing:setup`
// (docs/macos-folder-prompts.md). macOS keeps Allow and Don't Allow answers for folders and other apps' data against an
// app's designated requirement. An ad hoc signature's requirement is the build's own hash, so every build is asked
// again; a certificate's is the bundle id and that certificate, the same for every build. Node built-ins only, so it
// runs before anything is installed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The certificate's common name: the identity `pnpm package` signs with when it is in the keychain. */
export const LOCAL_SIGNING_NAME = 'agent-board local signing';

/** Runs a command, never throwing: its exit status and output. A seam, so tests run no `codesign` or `security`. */
export type Run = (command: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };

const run: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.error ? result.error.message : (result.stderr ?? '') };
};

/** What the keychain holds under `LOCAL_SIGNING_NAME`: one usable identity (its SHA-1), none, or several. */
export type LocalIdentity = { kind: 'one'; hash: string } | { kind: 'none' } | { kind: 'many'; hashes: string[] };

/**
 * Reads `security find-identity -p codesigning`. Only the "Matching identities" list counts, since the "Valid
 * identities only" list after it repeats them. A self-signed certificate is listed as not trusted, which `codesign`
 * signs with all the same; an expired or revoked one can't sign, so it is left out.
 */
export function parseLocalIdentity(findIdentityOutput: string, name: string = LOCAL_SIGNING_NAME): LocalIdentity {
  const matching = findIdentityOutput.split(/Valid identities only/)[0] ?? '';
  const hashes: string[] = [];
  for (const line of matching.split('\n')) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"(?:\s+\((.*)\))?\s*$/.exec(line);
    if (!match || match[2] !== name) continue;
    if (match[3] !== undefined && /EXPIRED|REVOKED/.test(match[3])) continue;
    if (!hashes.includes(match[1]!)) hashes.push(match[1]!);
  }
  if (hashes.length === 0) return { kind: 'none' };
  return hashes.length === 1 ? { kind: 'one', hash: hashes[0]! } : { kind: 'many', hashes };
}

function findLocalIdentity(exec: Run = run): LocalIdentity {
  const result = exec('security', ['find-identity', '-p', 'codesigning']);
  return result.status === 0 ? parseLocalIdentity(result.stdout) : { kind: 'none' };
}

/** The `designated => …` line of `codesign -d -r-`: what macOS checks a later build against. */
function designatedRequirement(app: string, exec: Run = run): string | undefined {
  const result = exec('codesign', ['-d', '-r-', app]);
  const line = `${result.stdout}\n${result.stderr}`.split('\n').find((l) => l.startsWith('designated => '));
  return line?.slice('designated => '.length);
}

/**
 * What to try when `codesign` can't use the key: a locked keychain (as over SSH) or a key whose access was never
 * allowed both fail with errSecInternalComponent or "User interaction is not allowed".
 */
const KEY_ACCESS_HINT = `If the keychain is locked (as over SSH), run \`security unlock-keychain\` and build again; if codesign was never allowed to use the key, build once from a terminal on this Mac's screen and choose Always Allow. To build ad hoc instead, delete "${LOCAL_SIGNING_NAME}" in Keychain Access.`;

/** Removing the certificate and its key, as a command: `security delete-identity` deletes both. */
const deleteIdentity = (hash: string) => `security delete-identity -Z ${hash}`;

const SETUP_HINT = `run \`pnpm signing:setup\` once so macOS keeps your answers to its folder pop-ups across updates (docs/macos-folder-prompts.md)`;

/**
 * Signs the built app with the local identity, if the keychain has exactly one, or leaves the ad hoc signature
 * electron-builder made and says how to set one up. No hardened runtime, as with the ad hoc signature, so node-pty and
 * the agents' own CLIs run as they did. Throws if `codesign` fails, so a half-signed app is never installed.
 */
export function signApp(app: string, log: (message: string) => void, exec: Run = run): 'local' | 'adhoc' {
  const identity = findLocalIdentity(exec);
  if (identity.kind === 'none') {
    log(`signed ad hoc: ${SETUP_HINT}.`);
    return 'adhoc';
  }
  if (identity.kind === 'many') {
    log(`signed ad hoc: the keychain has ${identity.hashes.length} "${LOCAL_SIGNING_NAME}" certificates (${identity.hashes.join(', ')}). Delete all but one in Keychain Access.`);
    return 'adhoc';
  }
  for (const args of [
    ['--force', '--deep', '--sign', identity.hash, app],
    ['--verify', '--deep', '--strict', app],
  ]) {
    const result = exec('codesign', args);
    if (result.status !== 0) throw new Error(`codesign ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}\n${KEY_ACCESS_HINT}`);
  }
  log(`signed with "${LOCAL_SIGNING_NAME}": ${designatedRequirement(app, exec) ?? 'no designated requirement read'}`);
  return 'local';
}

/** Where `setUpLocalSigning` works: a seam, so tests use a temp dir and fake commands. */
export interface SetupMachine {
  exec: Run;
  /** A fresh, empty dir for the key and certificate, removed afterwards. */
  makeTempDir(): string;
  removeDir(dir: string): void;
  log(message: string): void;
}

const realSetupMachine: SetupMachine = {
  exec: run,
  makeTempDir: () => mkdtempSync(join(tmpdir(), 'agent-board-signing-')),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  log: (message) => console.log(`signing:setup: ${message}`),
};

/**
 * Makes a self-signed code-signing certificate, `LOCAL_SIGNING_NAME`, in the login keychain, then signs a scratch copy
 * of a system binary with it, so the keychain's one-time question (may `codesign` use this key?) comes now and not in
 * the middle of a build. Does nothing if the identity is there already. The private key exists outside the keychain
 * only in a temp dir that is removed before this returns.
 */
export function setUpLocalSigning(machine: SetupMachine = realSetupMachine): LocalIdentity {
  const { exec, log } = machine;
  const existing = findLocalIdentity(exec);
  if (existing.kind !== 'none') {
    log(existing.kind === 'one' ? `already set up: "${LOCAL_SIGNING_NAME}" is in your keychain (${existing.hash}).` : `the keychain has ${existing.hashes.length} "${LOCAL_SIGNING_NAME}" certificates; delete all but one in Keychain Access.`);
    return existing;
  }
  const dir = machine.makeTempDir();
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    const p12 = join(dir, 'identity.p12');
    // A one-off password for the .p12, which is deleted with the dir. `security import` takes it only in argv (`-P`;
    // without it, it asks in a dialog), where `ps` shows it for the moment the import runs. That is acceptable: the
    // .p12 is in a 0700 temp dir, removed before this returns, and the password opens nothing else.
    const password = randomBytes(24).toString('hex');
    const passFile = join(dir, 'pass');
    writeFileSync(passFile, password, { mode: 0o600 });
    // The system's LibreSSL: its .p12 is one `security` reads (OpenSSL 3's default cipher isn't).
    const steps: [string, string[]][] = [
      [
        '/usr/bin/openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7300', '-subj', `/CN=${LOCAL_SIGNING_NAME}`, '-keyout', key, '-out', cert,
          '-addext', 'basicConstraints=critical,CA:false', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=critical,codeSigning'],
      ],
      ['/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `file:${passFile}`]],
      // Into the default (login) keychain, with codesign allowed to use the key.
      ['security', ['import', p12, '-P', password, '-T', '/usr/bin/codesign']],
    ];
    for (const [command, args] of steps) {
      const result = exec(command, args);
      if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`);
    }
    const made = findLocalIdentity(exec);
    if (made.kind !== 'one') {
      throw new Error(
        `the certificate was imported, but \`security find-identity\` doesn't list exactly one "${LOCAL_SIGNING_NAME}". Delete it in Keychain Access (search for "${LOCAL_SIGNING_NAME}"; delete the certificate and its private key), then run \`pnpm signing:setup\` again.`,
      );
    }
    log(`made "${LOCAL_SIGNING_NAME}" (${made.hash}) in your login keychain.`);
    log('Trying it once. If macOS asks whether codesign may use the key, type your login password and choose Always Allow.');
    const probe = join(dir, 'probe');
    copyFileSync('/usr/bin/true', probe);
    const signed = exec('codesign', ['--force', '--sign', made.hash, probe]);
    if (signed.status !== 0) {
      throw new Error(
        `the certificate is in your keychain, but codesign could not sign with it: ${signed.stderr.trim()}\n${KEY_ACCESS_HINT} To start over: \`${deleteIdentity(made.hash)}\`, then \`pnpm signing:setup\`.`,
      );
    }
    log('Done. The next `pnpm package` or `pnpm update:app` signs with it; macOS asks once more for each folder, then keeps your answers.');
    return made;
  } finally {
    machine.removeDir(dir);
  }
}
