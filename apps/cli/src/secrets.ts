import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where Keel keeps database tokens. Never a config file, never the environment (ADR 0001). */
export interface SecretStore {
  /** Shown to the user: "macOS Keychain", "a file only you can read (...)". */
  label: string;
  /** True when Keel fell back to this store because no system one was found, so it should say so. */
  fallback: boolean;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = 'keel';
// Tokens are JWTs or similar: refuse anything that could break out of the quoting below.
const SAFE = /^[A-Za-z0-9._~+/=-]+$/;

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input ?? '');
  });
}

function has(cmd: string): Promise<boolean> {
  return new Promise((resolve) => execFile('which', [cmd], (err) => resolve(!err)));
}

function checkSafe(secret: string): void {
  if (!SAFE.test(secret)) throw new Error("That token has characters Keel doesn't expect. Copy it again from your database provider.");
}

/** macOS Keychain, through `security -i` so the token goes over stdin, not the process list. */
const keychain: SecretStore = {
  label: 'macOS Keychain',
  fallback: false,
  async get(account) {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return r.code === 0 ? r.stdout.trim() || null : null;
  },
  async set(account, secret) {
    checkSafe(secret);
    checkSafe(account);
    const r = await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a "${account}" -l "Keel database token" -w "${secret}"\n`);
    if (r.code !== 0) throw new Error('Could not save the token in the Keychain.');
  },
  async delete(account) {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  },
};

/** Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool`, secret on stdin. */
const secretTool: SecretStore = {
  label: 'the system keyring',
  fallback: false,
  async get(account) {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  },
  async set(account, secret) {
    const r = await run('secret-tool', ['store', '--label', 'Keel database token', 'service', SERVICE, 'account', account], secret);
    if (r.code !== 0) throw new Error('Could not save the token in the system keyring.');
  },
  async delete(account) {
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
  },
};

/** Last resort: a JSON file readable only by you (mode 600). */
function fileStore(home: string, chosen: boolean): SecretStore {
  const file = join(home, 'secrets.json');
  const read = (): Record<string, string> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return {
    label: `a file only you can read (${file})`,
    fallback: !chosen,
    async get(account) {
      return read()[account] ?? null;
    },
    async set(account, secret) {
      write({ ...read(), [account]: secret });
    },
    async delete(account) {
      const data = read();
      delete data[account];
      write(data);
    },
  };
}

/** The system secret store when there is one. `KEEL_SECRET_STORE=file` forces the file (tests, headless servers). */
export async function secretStore(home: string, env: NodeJS.ProcessEnv = process.env): Promise<SecretStore> {
  if (env.KEEL_SECRET_STORE === 'file') return fileStore(home, true);
  if (process.platform === 'darwin' && (await has('security'))) return keychain;
  if (process.platform === 'linux' && (await has('secret-tool'))) return secretTool;
  return fileStore(home, false);
}
