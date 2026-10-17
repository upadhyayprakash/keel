import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, renderText, totpCode, totpStep, type Block } from '@keel/core';
import { authCommand, TOTP_ACCOUNT, TOTP_LABEL } from '../src/auth';
import { safeLabel } from '../src/secrets';

const URL = 'https://keel.example.ts.net';
const credential = (n = 1) => ({ credentialId: `cred-${n}`, publicKey: `key-${n}`, counter: 0, transports: ['internal'] });

let home: string;
let store: AuthStore;
let out: string[];
const io = {
  paint: (text: string) => text,
  print: (blocks: Block[]) => out.push(renderText(blocks)),
  write: (text: string) => out.push(text),
};
const text = () => out.join('\n');
const run = (...args: string[]) => authCommand(store, args, io, { every: 1, sleep: async () => {} });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-auth-cli-'));
  store = AuthStore.at(home);
  out = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('keel auth passkey add', () => {
  it('needs keel serve running with a public address', async () => {
    await expect(run('passkey', 'add')).rejects.toThrow("keel serve isn't running with a public address");
  });

  it('prints a QR code and the link, then waits for the phone', async () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    let polls = 0;
    const code = await authCommand(store, ['passkey', 'add', '--name', 'My iPhone'], io, {
      every: 1,
      // The phone uses the link while the terminal waits.
      sleep: async () => {
        if (++polls === 2) {
          const token = /pair#([\w-]+)/.exec(text())![1]!;
          store.completePairing(token, credential());
        }
      },
    });
    expect(code).toBe(0);
    expect(text()).toContain(`Or open: ${URL}/pair#`);
    expect(text()).toMatch(/[▀▄█]/);
    expect(text()).toContain('Works once, for 10 minutes');
    expect(text()).toContain('Paired: My iPhone');
    expect(store.passkeys().map((p) => p.name)).toEqual(['My iPhone']);
  });

  it('names the phone when no name is given', async () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    const done = authCommand(store, ['passkey', 'add'], io, {
      every: 1,
      sleep: async () => {
        const token = /pair#([\w-]+)/.exec(text())![1]!;
        if (!store.passkeys().length) store.completePairing(token, credential());
      },
    });
    expect(await done).toBe(0);
    expect(store.passkeys()[0]!.name).toBe('Phone 1');
  });

  it('turns the link off when stopped with Ctrl+C', async () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    const code = await authCommand(store, ['passkey', 'add'], io, { every: 1, sleep: async () => {}, cancelled: Promise.resolve() });
    expect(code).toBe(1);
    expect(text()).toContain('Stopped. That link no longer works.');
    const token = /pair#([\w-]+)/.exec(text())![1]!;
    expect(() => store.checkPairing(token)).toThrow('not valid');
  });

  it('warns when other passkeys are for another hostname', async () => {
    store.writeServerInfo({ publicUrl: 'https://old.example.ts.net', port: 4242, pid: process.pid });
    store.completePairing(store.createPairing('Old phone', 'https://old.example.ts.net').token, credential(1));
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    await authCommand(store, ['passkey', 'add'], io, { every: 1, sleep: async () => {}, cancelled: Promise.resolve() });
    expect(text()).toContain("Your other passkeys are for old.example.ts.net. They don't work at keel.example.ts.net.");
  });

  it('needs a value after --name', async () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    await expect(run('passkey', 'add', '--name')).rejects.toThrow('--name needs a value');
  });
});

describe('keel auth passkey list and remove', () => {
  it('lists passkeys, then removes one with its sessions', async () => {
    expect(await run('passkey')).toBe(0);
    expect(text()).toContain('No passkeys yet.');

    const phone = store.completePairing(store.createPairing('My iPhone', URL).token, credential());
    store.createSession({ passkeyId: phone.id, method: 'passkey', scope: 'goals' });
    out = [];
    await run('passkey', 'list');
    expect(text()).toContain('My iPhone');
    expect(text()).toContain('keel.example.ts.net');
    expect(text()).toContain('never');

    out = [];
    await run('passkey', 'remove', 'my iphone');
    expect(text()).toContain('Removed My iPhone');
    expect(text()).toContain('Ended 1 session it had started.');
    expect(store.passkeys()).toEqual([]);
  });

  it('asks which passkey to remove', async () => {
    await expect(run('passkey', 'remove')).rejects.toThrow('Which passkey?');
  });
});

describe('keel auth sessions', () => {
  it('lists and ends sessions', async () => {
    const phone = store.completePairing(store.createPairing('My iPhone', URL).token, credential());
    const { session } = store.createSession({ passkeyId: phone.id, method: 'passkey', scope: 'goals' });
    store.createSession({ passkeyId: null, method: 'totp', scope: 'terminal' });
    await run('sessions');
    expect(text()).toContain('Goals');
    expect(text()).toContain('TOTP code');

    out = [];
    await run('sessions', 'revoke', session.id);
    expect(text()).toContain(`Ended session ${session.id}.`);
    out = [];
    await run('sessions', 'revoke', '--all');
    expect(text()).toContain('Ended 1 session.');
    out = [];
    await run('sessions');
    expect(text()).toContain('No open sessions.');
  });
});

describe('keel auth', () => {
  it('shows what is set up', async () => {
    await run();
    expect(text()).toContain('Passkeys  none');
    expect(text()).toContain('not running with a public address');
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    store.completePairing(store.createPairing('My iPhone', URL).token, credential());
    out = [];
    await run('status');
    expect(text()).toContain('Passkeys  1 (for keel.example.ts.net)');
    expect(text()).toContain(`keel serve at ${URL}`);
  });

  it('explains unknown subcommands', async () => {
    await expect(run('totp')).rejects.toThrow('Unknown "auth totp"');
    await expect(run('passkey', 'rename')).rejects.toThrow('Unknown "auth passkey rename"');
  });
});

describe('keel auth totp', () => {
  const NOW = 1_700_000_000_000;
  /** An in-memory secret store and a terminal that answers with the given lines. */
  type Answer = string | (() => string);
  const setup = (answers: (key: () => string) => Answer[]) => {
    const saved = new Map<string, string>();
    const secrets = {
      label: 'a test store',
      fallback: false,
      get: async (account: string) => saved.get(account) ?? null,
      set: async (account: string, secret: string) => void saved.set(account, secret),
      delete: async (account: string) => void saved.delete(account),
    };
    const key = () => /Or type this key: ([A-Z2-7 ]+)/.exec(text())![1]!.replace(/ /g, '');
    const queue = answers(key);
    const terminal = {
      ...io,
      ask: async () => {
        const answer = queue.shift() ?? '';
        return typeof answer === 'function' ? answer() : answer;
      },
    };
    const totp = (...args: string[]) => authCommand(store, ['totp', ...args], terminal, { secrets, account: 'my-mac', now: () => NOW });
    return { saved, totp };
  };

  it('shows a QR code and the key, and turns codes on after a right code', async () => {
    // The right code is worked out from the key the terminal printed.
    const { saved, totp } = setup((key) => ['000000', () => totpCode(key(), NOW)]);
    const result = await totp('enable');
    expect(result).toBe(0);
    expect(text()).toMatch(/[▀▄█]/);
    expect(text()).toContain("That code isn't right");
    expect(text()).toContain('Codes are on.');
    expect(saved.get(TOTP_ACCOUNT)).toMatch(/^[A-Z2-7]{32}$/);
    expect(store.totp()?.lastStep).toBe(totpStep(NOW));
  });

  it('names the entry after this computer, or after --label', async () => {
    const plain = setup(() => []);
    await plain.totp('enable');
    expect(text()).toContain('The app lists it as Keel (my-mac).');
    out = [];
    const labelled = setup(() => []);
    await labelled.totp('enable', '--label', 'Keel at home');
    expect(text()).toContain('The app lists it as Keel (Keel at home).');
    expect(text()).not.toContain('my-mac');
    await expect(labelled.totp('enable', '--label')).rejects.toThrow('--label needs a value.');
  });

  it('stays off after three wrong codes, or when there is no answer', async () => {
    const wrong = setup(() => ['000000', '111111', '222222']);
    expect(await wrong.totp('enable')).toBe(1);
    expect(text()).toContain('Codes are still off.');
    expect(store.totp()).toBeNull();
    expect(wrong.saved.size).toBe(0);
    out = [];
    expect(await setup(() => []).totp('enable')).toBe(1);
  });

  it('refuses to enable twice, and disabling removes the key and ends code sessions', async () => {
    const { saved, totp } = setup(() => []);
    saved.set(TOTP_ACCOUNT, 'KEY');
    store.enableTotp(1);
    store.createSession({ passkeyId: null, method: 'totp', scope: 'goals' });
    await expect(totp('enable')).rejects.toThrow('Codes are already on.');
    expect(await totp('disable')).toBe(0);
    expect(text()).toContain('Ended 1 session a code had started.');
    expect(saved.size).toBe(0);
    expect(store.totp()).toBeNull();
    out = [];
    expect(await totp('disable')).toBe(0);
    expect(text()).toContain('Codes are already off.');
  });

  it('shows codes in keel auth', async () => {
    await run();
    expect(text()).toMatch(/Codes\s+off/);
    store.enableTotp(1);
    out = [];
    await run();
    expect(text()).toMatch(/Codes\s+on/);
  });
});

describe('keel auth totp, saving the key', () => {
  it('uses a label the Keychain accepts', () => {
    expect(safeLabel(TOTP_LABEL)).toBe(true);
    expect(safeLabel('Keel database token')).toBe(true);
    expect(safeLabel('a "quoted" label')).toBe(false);
  });

  it('says so, and leaves codes off, when the secret store refuses the key', async () => {
    const secrets = {
      label: 'the Keychain',
      fallback: false,
      get: async () => null,
      set: async () => {
        throw new Error('Could not save the token in the Keychain.');
      },
      delete: async () => {},
    };
    const key = () => /Or type this key: ([A-Z2-7 ]+)/.exec(text())![1]!.replace(/ /g, '');
    const terminal = { ...io, ask: async () => totpCode(key(), 1_700_000_000_000) };
    await expect(authCommand(store, ['totp', 'enable'], terminal, { secrets, account: 'my-mac', now: () => 1_700_000_000_000 })).rejects.toThrow(
      "Couldn't save the key in the Keychain, so codes are still off.",
    );
    expect(store.totp()).toBeNull();
  });
});
