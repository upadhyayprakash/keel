import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { useEffect, useState, type ReactNode } from 'react';
import { authApi, SIGNED_OUT, type AuthState, type Scope } from './api';
import { applyTheme, resolve } from './theme';

// ADR 0002: the sign-in and pairing pages. One page for the browser terminal and
// Goals: Goals sends people to /signin?scope=goals&next=/goals/.

/** Only a path on this site, never another site (`//evil.example`). */
export function safeNext(value: string | null, fallback = '/'): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : fallback;
}

/** What went wrong, in words. A cancelled Face ID prompt is not an error worth shouting about. */
function describe(error: unknown): string {
  if (error instanceof WebAuthnError && error.code === 'ERROR_CEREMONY_ABORTED') return 'Cancelled.';
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Cancelled, or the passkey prompt timed out. Try again.';
  if (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a Keel passkey. Sign in instead.';
  return error instanceof Error ? error.message : String(error);
}

function Shell({ label, children }: { label: string; children: ReactNode }) {
  useEffect(() => applyTheme(resolve('auto')), []);
  return (
    <div className="app">
      <div className="window">
        <header className="top">
          <div className="wordmark" aria-label="keel">
            <span className="chev">›</span>
            <span className="word">keel</span>
          </div>
          <span className="meta">{label}</span>
        </header>
        <main className="auth">
          <div className="auth-card">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Passkeys are bound to the public address; on any other (localhost, a LAN IP) send people there. */
function WrongAddress({ origin, path }: { origin: string; path: string }) {
  return (
    <>
      <Message tone="muted" text={`Passkeys for this Keel work at ${origin}.`} hint="Not at this address, even on the same computer." />
      <a className="primary" href={origin + path}>
        Open {new URL(origin).host}
      </a>
    </>
  );
}

function Message({ tone, text, hint }: { tone: 'error' | 'muted' | 'done'; text: string; hint?: string }) {
  return (
    <div className={`auth-msg ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{text}</p>
      {hint && <p className="auth-hint">{hint}</p>}
    </div>
  );
}

/** The sign-in screen. On success it calls `done`, or goes to `next`. */
export function SignIn({ scope, ended, done, next }: { scope: Scope; ended?: boolean; done?: () => void; next?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; hint?: string } | null>(null);
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => void authApi.state().then(setState, () => setState(null)), []);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await authApi.signInOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await authApi.signIn(scope, response);
      if (done) done();
      else window.location.assign(next ?? '/');
    } catch (e) {
      setError(e instanceof authApi.Problem ? { text: e.message, hint: e.hint } : { text: describe(e) });
    } finally {
      setBusy(false);
    }
  };

  const what = scope === 'terminal' ? 'the browser terminal' : 'Goals';
  const supported = browserSupportsWebAuthn();
  return (
    <Shell label="sign in">
      <h1>Sign in to {what}</h1>
      {ended && <Message tone="muted" text="Your session ended." />}
      {state && !state.passkeys ? (
        <Message tone="error" text="Passkeys need a public address." hint="Start keel serve with --public-url https://<your-tunnel-name>" />
      ) : state?.origin && state.origin !== window.location.origin ? (
        <WrongAddress origin={state.origin} path={window.location.pathname + window.location.search} />
      ) : !supported ? (
        <Message tone="error" text="This browser can't use passkeys." hint="Open this page in Safari, Chrome or Firefox on a phone or computer with a screen lock." />
      ) : (
        <>
          <p className="auth-lead">Use the passkey you paired from your computer.</p>
          <button className="primary" onClick={() => void signIn()} disabled={busy} autoFocus>
            {busy ? 'Waiting for your passkey...' : 'Sign in with passkey'}
          </button>
        </>
      )}
      {error && <Message tone="error" text={error.text} hint={error.hint} />}
      <p className="auth-foot">
        No passkey on this device? On your computer, run <code>keel auth passkey add</code> and scan the code.
      </p>
    </Shell>
  );
}

/** /pair#<token>: opened from the QR code `keel auth passkey add` prints. */
export function Pair() {
  // Read the token once and take it out of the address bar and history.
  const [token] = useState(() => {
    const value = window.location.hash.slice(1);
    if (value) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return value;
  });
  const [name, setName] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; hint?: string } | null>(null);
  const next = safeNext(new URLSearchParams(window.location.search).get('next'));

  useEffect(() => {
    if (!token) return;
    authApi.state().then((s) => setOrigin(s.origin ?? null), () => {});
    authApi.pairOptions(token).then(
      (r) => setName(r.name),
      (e) => setError(e instanceof authApi.Problem ? { text: e.message, hint: e.hint } : { text: describe(e) }),
    );
  }, [token]);

  // iOS only shows the passkey sheet from a tap, so this runs on the button, with fresh options.
  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await authApi.pairOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      setPaired((await authApi.pair(token, response)).paired);
    } catch (e) {
      setError(e instanceof authApi.Problem ? { text: e.message, hint: e.hint } : { text: describe(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Shell label="pair">
        <h1>Pair this device</h1>
        <Message tone="error" text="This page needs the link from your computer." hint="On your computer, run keel auth passkey add and scan the code." />
      </Shell>
    );
  }
  if (paired) {
    return (
      <Shell label="pair">
        <h1>Paired</h1>
        <Message tone="done" text={`${paired} can now sign in to Keel.`} hint="Your computer shows Paired too. Add this page to your home screen to stay signed in." />
        <a className="primary" href={next}>
          Continue
        </a>
      </Shell>
    );
  }
  if (origin && origin !== window.location.origin) {
    return (
      <Shell label="pair">
        <h1>Pair this device</h1>
        <WrongAddress origin={origin} path={`/pair${window.location.search}#${token}`} />
      </Shell>
    );
  }
  return (
    <Shell label="pair">
      <h1>Pair this device</h1>
      {error ? (
        <Message tone="error" text={error.text} hint={error.hint} />
      ) : !browserSupportsWebAuthn() ? (
        <Message tone="error" text="This browser can't use passkeys." hint="Open the link in Safari or Chrome." />
      ) : (
        <p className="auth-lead">{name ? `Creates a passkey named ${name} for this Keel. You approve it with Face ID, a fingerprint or your screen lock.` : 'Checking the link...'}</p>
      )}
      {(!error || error.text === 'Cancelled.' || error.text.startsWith('Cancelled,')) && (
        <button className="primary" onClick={() => void pair()} disabled={busy || !name} autoFocus>
          {busy ? 'Waiting for your passkey...' : 'Create passkey'}
        </button>
      )}
    </Shell>
  );
}

/**
 * Shows the browser terminal when it may: straight away without login, after
 * sign-in with it. Comes back here when a session ends mid-use.
 */
export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'sign-in' | 'ended' | 'offline'>('checking');

  useEffect(() => {
    authApi.state().then(
      (s) => setState(!s.login || s.signedIn.terminal ? 'open' : 'sign-in'),
      () => setState('offline'),
    );
    const onSignedOut = () => setState('ended');
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  if (state === 'open') return <>{children}</>;
  if (state === 'sign-in' || state === 'ended') return <SignIn scope="terminal" ended={state === 'ended'} done={() => setState('open')} />;
  if (state === 'offline') {
    return (
      <Shell label="">
        <Message tone="error" text="Can't reach keel serve. Is it still running?" />
      </Shell>
    );
  }
  return null;
}
