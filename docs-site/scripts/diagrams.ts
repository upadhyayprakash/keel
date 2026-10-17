// Draws the login diagrams for guides/phone-login.mdx and guides/how-login-works.mdx
// as SVG, once per theme, in Keel's own colours. Called by generate.ts, so CI
// catches a diagram that no longer matches this file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { palettes, type ThemeName } from '../../packages/core/src/palettes';

const W = 720;
const SANS = "'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

interface Theme {
  bg: string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  blue: string;
  green: string;
  red: string;
  teal: string;
  violet: string;
}

function theme(name: ThemeName): Theme {
  const { tones, ui } = palettes[name];
  return { bg: ui.bg, panel: ui.panel, line: ui.line, text: tones.default, muted: tones.muted, accent: tones.accent, blue: tones.wait, green: tones.done, red: tones.late, teal: tones.teal, violet: tones.violet };
}

type Color = keyof Theme;
/** A theme colour by name, or a colour value taken from the theme. */
type Paint = Color | (string & {});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Splits text into lines that fit a width, by an average character width. */
function wrap(text: string, width: number, size: number, mono = false): string[] {
  const max = Math.max(8, Math.floor(width / (size * (mono ? 0.62 : 0.56))));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** A small drawing kit bound to one theme. */
function kit(t: Theme) {
  const c = (color: Paint) => (color in t ? t[color as Color] : color);
  return {
    c,
    rect(x: number, y: number, w: number, h: number, o: { fill?: Paint; stroke?: Paint; r?: number; dash?: boolean; width?: number } = {}) {
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 10}" fill="${o.fill ? c(o.fill) : 'none'}" stroke="${o.stroke ? c(o.stroke) : 'none'}" stroke-width="${o.width ?? 1.5}"${o.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
    },
    text(x: number, y: number, s: string, o: { size?: number; weight?: number; fill?: Paint; anchor?: 'start' | 'middle' | 'end'; mono?: boolean } = {}) {
      return `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${o.size ?? 13}" font-weight="${o.weight ?? 400}" fill="${c(o.fill ?? 'text')}" text-anchor="${o.anchor ?? 'start'}">${esc(s)}</text>`;
    },
    /** Several lines, top-aligned at y. Returns the svg and the height used. */
    lines(x: number, y: number, rows: string[], o: { size?: number; weight?: number; fill?: Paint; anchor?: 'start' | 'middle' | 'end'; mono?: boolean; gap?: number } = {}) {
      const size = o.size ?? 13;
      const gap = o.gap ?? Math.round(size * 1.35);
      return {
        svg: rows.map((row, i) => this.text(x, y + size + i * gap, row, o)).join(''),
        height: rows.length ? size + (rows.length - 1) * gap + 4 : 0,
      };
    },
    arrow(x1: number, y1: number, x2: number, y2: number, o: { color?: Color; dash?: boolean; both?: boolean; width?: number } = {}) {
      const color = c(o.color ?? 'muted');
      const head = (fx: number, fy: number, tx: number, ty: number) => {
        const a = Math.atan2(ty - fy, tx - fx);
        const p = (d: number, s: number) => `${tx - 10 * Math.cos(a + s * d)},${ty - 10 * Math.sin(a + s * d)}`;
        return `<polygon points="${tx},${ty} ${p(0.45, 1)} ${p(0.45, -1)}" fill="${color}"/>`;
      };
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${o.width ?? 1.75}"${o.dash ? ' stroke-dasharray="6 5"' : ''}/>` +
        head(x1, y1, x2, y2) +
        (o.both ? head(x2, y2, x1, y1) : '')
      );
    },
    badge(cx: number, cy: number, n: number | string, color: Color = 'accent') {
      return `<circle cx="${cx}" cy="${cy}" r="10" fill="${c(color)}"/>` + this.text(cx, cy + 4, String(n), { size: 11, weight: 700, fill: t.bg, anchor: 'middle' });
    },
    icon(kind: Icon, cx: number, cy: number, color: Color) {
      const s = c(color);
      const stroke = `fill="none" stroke="${s}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
      switch (kind) {
        case 'phone':
          return `<g ${stroke}><rect x="${cx - 9}" y="${cy - 15}" width="18" height="30" rx="4"/><line x1="${cx - 3}" y1="${cy + 10}" x2="${cx + 3}" y2="${cy + 10}"/></g>`;
        case 'terminal':
          return `<g ${stroke}><rect x="${cx - 16}" y="${cy - 12}" width="32" height="24" rx="4"/><path d="M${cx - 9} ${cy - 4} l5 4 l-5 4"/><line x1="${cx}" y1="${cy + 5}" x2="${cx + 8}" y2="${cy + 5}"/></g>`;
        case 'server':
          return `<g ${stroke}><rect x="${cx - 15}" y="${cy - 13}" width="30" height="11" rx="3"/><rect x="${cx - 15}" y="${cy + 2}" width="30" height="11" rx="3"/><circle cx="${cx - 9}" cy="${cy - 7.5}" r="1" fill="${s}"/><circle cx="${cx - 9}" cy="${cy + 7.5}" r="1" fill="${s}"/></g>`;
        case 'cloud':
          return `<g ${stroke}><path d="M${cx - 12} ${cy + 9} h22 a8 8 0 0 0 0 -16 a11 11 0 0 0 -21 -2 a8 8 0 0 0 -1 18 z"/></g>`;
        case 'key':
          return `<g ${stroke}><circle cx="${cx - 7}" cy="${cy}" r="6"/><path d="M${cx - 1} ${cy} h14 m-4 0 v5 m-5 -5 v4"/></g>`;
        case 'app':
          return `<g ${stroke}><circle cx="${cx}" cy="${cy}" r="13"/><path d="M${cx} ${cy - 7} v7 l5 4"/></g>`;
        case 'folder':
          return `<g ${stroke}><path d="M${cx - 15} ${cy - 10} h10 l3 4 h17 v17 h-30 z"/></g>`;
        case 'browser':
          return `<g ${stroke}><rect x="${cx - 16}" y="${cy - 12}" width="32" height="24" rx="4"/><line x1="${cx - 16}" y1="${cy - 5}" x2="${cx + 16}" y2="${cy - 5}"/></g>`;
        case 'person':
          return `<g ${stroke}><circle cx="${cx}" cy="${cy - 6}" r="6"/><path d="M${cx - 11} ${cy + 13} a11 9 0 0 1 22 0"/></g>`;
      }
    },
  };
}

type Icon = 'phone' | 'terminal' | 'server' | 'cloud' | 'key' | 'app' | 'folder' | 'browser' | 'person';
type Kit = ReturnType<typeof kit>;

function frame(t: Theme, height: number, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img" aria-label="${esc(label)}"><rect width="${W}" height="${height}" rx="14" fill="${t.bg}"/>${body}</svg>\n`;
}

// ---- sequence diagrams ----

interface Lane {
  id: string;
  label: string;
  sub: string;
  icon: Icon;
  color: Color;
}
type Step = { from: string; to: string; text: string; dash?: boolean } | { at: string; text: string; tone?: Color };

function sequence(t: Theme, label: string, lanes: Lane[], steps: Step[]): string {
  const k = kit(t);
  const gap = W / lanes.length;
  const x = (id: string) => gap * lanes.findIndex((l) => l.id === id) + gap / 2;
  let svg = '';
  // Headers
  lanes.forEach((lane, i) => {
    const cx = gap * i + gap / 2;
    const w = Math.min(gap - 20, 200);
    svg += k.rect(cx - w / 2, 18, w, 92, { fill: 'panel', stroke: lane.color });
    svg += k.icon(lane.icon, cx, 44, lane.color);
    svg += k.text(cx, 80, lane.label, { size: 13, weight: 700, anchor: 'middle' });
    svg += k.text(cx, 98, lane.sub, { size: 11, fill: 'muted', anchor: 'middle', mono: true });
  });
  let y = 132;
  const rows: string[] = [];
  steps.forEach((step, i) => {
    const n = i + 1;
    if ('at' in step) {
      const cx = x(step.at);
      const w = Math.min(gap * 0.92, 300);
      const text = k.lines(cx, y + 10, wrap(step.text, w - 36, 12), { size: 12, anchor: 'middle' });
      const h = text.height + 22;
      rows.push(k.rect(cx - w / 2, y, w, h, { fill: 'panel', stroke: step.tone ?? 'line', r: 8 }) + text.svg + k.badge(cx - w / 2, y, n));
      y += h + 16;
    } else {
      const [x1, x2] = [x(step.from), x(step.to)];
      const span = Math.abs(x2 - x1) - 30;
      const rows12 = wrap(step.text, span, 12);
      const text = k.lines((x1 + x2) / 2, y, rows12, { size: 12, anchor: 'middle' });
      const lineY = y + text.height + 8;
      // A backing so a lifeline crossing the label doesn't run through the words.
      const labelW = Math.max(...rows12.map((r) => r.length)) * 12 * 0.56 + 12;
      const backing = k.rect((x1 + x2) / 2 - labelW / 2, y, labelW, text.height + 2, { fill: 'bg', r: 4 });
      rows.push(backing + text.svg + k.arrow(x1 + Math.sign(x2 - x1) * 4, lineY, x2 - Math.sign(x2 - x1) * 4, lineY, { color: 'muted', dash: step.dash }) + k.badge(x1 + Math.sign(x2 - x1) * 16, lineY - 13, n));
      y = lineY + 22;
    }
  });
  const height = y + 10;
  // Lifelines behind the steps
  const lifelines = lanes.map((l) => `<line x1="${x(l.id)}" y1="110" x2="${x(l.id)}" y2="${height - 14}" stroke="${k.c(l.color)}" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="3 5"/>`).join('');
  return frame(t, height, lifelines + svg + rows.join(''), label);
}

const LANES: Record<string, Lane> = {
  terminal: { id: 'terminal', label: 'Your terminal', sub: 'keel auth ...', icon: 'terminal', color: 'accent' },
  serve: { id: 'serve', label: 'keel serve', sub: 'on your computer', icon: 'server', color: 'blue' },
  phone: { id: 'phone', label: 'Your phone', sub: 'browser', icon: 'phone', color: 'teal' },
  store: { id: 'store', label: 'Login files', sub: '~/.keel/auth', icon: 'folder', color: 'violet' },
  app: { id: 'app', label: 'Authenticator app', sub: 'on your phone', icon: 'app', color: 'violet' },
  keychain: { id: 'keychain', label: 'Keychain', sub: 'secret store', icon: 'key', color: 'green' },
  browser: { id: 'browser', label: 'Any browser', sub: 'sign-in page', icon: 'browser', color: 'teal' },
};

// ---- the diagrams ----

function overview(t: Theme): string {
  const k = kit(t);
  let s = '';
  // Phone
  s += k.rect(20, 70, 150, 120, { fill: 'panel', stroke: 'teal' }) + k.icon('phone', 95, 105, 'teal');
  s += k.text(95, 150, 'Your phone', { weight: 700, anchor: 'middle' }) + k.text(95, 168, 'anywhere', { size: 11, fill: 'muted', anchor: 'middle' });
  // Tunnel
  s += k.rect(215, 70, 170, 120, { fill: 'panel', stroke: 'blue', dash: true }) + k.icon('cloud', 300, 104, 'blue');
  s += k.text(300, 150, 'HTTPS tunnel', { weight: 700, anchor: 'middle' }) + k.text(300, 168, 'Tailscale Funnel', { size: 11, fill: 'muted', anchor: 'middle' });
  // Computer
  s += k.rect(425, 20, 275, 300, { stroke: 'line', width: 2, r: 14 }) + k.text(441, 44, 'Your computer', { size: 12, weight: 700, fill: 'muted' });
  s += k.rect(445, 70, 235, 70, { fill: 'panel', stroke: 'blue' }) + k.icon('server', 478, 105, 'blue');
  s += k.text(505, 100, 'keel serve', { weight: 700 }) + k.text(505, 118, '--public-url https://...', { size: 11, fill: 'muted', mono: true });
  s += k.rect(445, 165, 112, 70, { fill: 'panel', stroke: 'violet' }) + k.icon('folder', 466, 200, 'violet');
  s += k.text(486, 196, 'Logins', { size: 12, weight: 700 }) + k.text(486, 212, '~/.keel/auth', { size: 9, fill: 'muted', mono: true });
  s += k.rect(568, 165, 112, 70, { fill: 'panel', stroke: 'green' }) + k.icon('key', 593, 200, 'green');
  s += k.text(612, 196, 'Keychain', { size: 12, weight: 700 }) + k.text(612, 212, 'code key', { size: 10, fill: 'muted' });
  s += k.rect(445, 255, 235, 50, { fill: 'panel', stroke: 'accent' }) + k.icon('terminal', 475, 280, 'accent');
  s += k.text(502, 276, 'Your terminal', { size: 12, weight: 700 }) + k.text(502, 293, 'keel auth: add and remove logins', { size: 10, fill: 'muted' });
  // Arrows
  s += k.arrow(172, 130, 213, 130, { both: true, color: 'teal' });
  s += k.arrow(387, 115, 443, 105, { color: 'blue' }) + k.text(300, 215, 'forwards to', { size: 11, fill: 'muted', anchor: 'middle' }) + k.text(300, 231, '127.0.0.1:4242', { size: 11, fill: 'muted', anchor: 'middle', mono: true });
  s += k.arrow(530, 142, 510, 163, { color: 'violet' }) + k.arrow(600, 142, 620, 163, { color: 'green' });
  s += k.arrow(540, 253, 510, 237, { color: 'accent' });
  // Footer
  s += k.text(20, 240, 'The phone can only sign in.', { size: 12, weight: 700 });
  s += k.lines(20, 248, ['Adding or removing a login only', 'works from your own terminal.'], { size: 12, fill: 'muted' }).svg;
  return frame(t, 340, s, 'Overview: your phone reaches keel serve on your computer through an HTTPS tunnel');
}

function modes(t: Theme): string {
  const k = kit(t);
  const cards: { cmd: string[]; title: string; body: string; login: string; color: Color; icon: Icon }[] = [
    { cmd: ['keel serve'], title: 'Only this computer', body: 'Same as always. Open http://localhost:4242. No login.', login: 'login off', color: 'muted', icon: 'browser' },
    { cmd: ['keel serve', '--public-url https://...'], title: 'Through a tunnel', body: 'Your phone, from anywhere. Passkeys work. Every request needs a login.', login: 'login on', color: 'accent', icon: 'cloud' },
    { cmd: ['keel serve --host 0.0.0.0', '--cert c.pem --key k.pem'], title: 'Your own network', body: 'Refuses to start until a login is set up. Codes work here, passkeys need the tunnel.', login: 'login on', color: 'blue', icon: 'server' },
  ];
  const w = 216;
  let s = '';
  cards.forEach((card, i) => {
    const x = 18 + i * (w + 15);
    s += k.rect(x, 18, w, 244, { fill: 'panel', stroke: card.color });
    s += k.icon(card.icon, x + 30, 48, card.color);
    s += k.rect(x + w - 82, 36, 68, 24, { fill: card.color, r: 12 }) + k.text(x + w - 48, 52, card.login, { size: 11, weight: 700, fill: t.bg, anchor: 'middle' });
    s += k.text(x + 16, 92, card.title, { size: 15, weight: 700 });
    s += k.rect(x + 14, 104, w - 28, 50, { fill: 'bg', stroke: 'line', r: 6 });
    s += k.lines(x + 24, 110, card.cmd, { size: 10.5, mono: true, fill: 'text', gap: 16 }).svg;
    s += k.lines(x + 16, 168, wrap(card.body, w - 32, 12.5), { size: 12.5, fill: 'muted' }).svg;
  });
  return frame(t, 280, s, 'Three ways to run keel serve: only this computer, through a tunnel, or on your own network');
}

const pairing = (t: Theme) =>
  sequence(t, 'Pairing a phone with a passkey', [LANES.terminal!, LANES.serve!, LANES.phone!], [
    { at: 'terminal', text: 'keel auth passkey add makes a one-time link (10 minutes) and shows it as a QR code' },
    { from: 'terminal', to: 'phone', text: 'You scan the QR code with the phone camera', dash: true },
    { at: 'phone', text: 'Opens /pair and wipes the link secret from the address bar' },
    { from: 'phone', to: 'serve', text: 'Is this link valid?' },
    { from: 'serve', to: 'phone', text: 'Yes: here is a one-time challenge' },
    { at: 'phone', text: 'You tap Create passkey and approve with Face ID. A new key pair is made; the private key never leaves the phone', tone: 'teal' },
    { from: 'phone', to: 'serve', text: 'Public key + the signed challenge' },
    { at: 'serve', text: 'Checks the link, challenge, address and Face ID. Saves the passkey and uses up the link', tone: 'blue' },
    { from: 'serve', to: 'phone', text: 'Paired, and signed in to Goals' },
    { at: 'terminal', text: 'Sees the link was used and prints Paired', tone: 'accent' },
  ]);

const signIn = (t: Theme) =>
  sequence(t, 'Signing in with a passkey', [LANES.phone!, LANES.serve!, LANES.store!], [
    { from: 'phone', to: 'serve', text: 'I want to sign in' },
    { from: 'serve', to: 'phone', text: 'One-time challenge (5 minutes). No username needed' },
    { at: 'phone', text: 'Face ID unlocks the passkey, which signs the challenge', tone: 'teal' },
    { from: 'phone', to: 'serve', text: 'Signature + which passkey it is' },
    { from: 'serve', to: 'store', text: "Look up that passkey's public key" },
    { at: 'serve', text: 'Checks the signature, the address and that Face ID was used', tone: 'blue' },
    { from: 'serve', to: 'store', text: 'Save the new session (only a hash of it)' },
    { from: 'serve', to: 'phone', text: 'Session cookie: terminal 12 hours, Goals 30 days' },
  ]);

const codesSetup = (t: Theme) =>
  sequence(t, 'Turning on codes', [LANES.terminal!, LANES.app!, LANES.keychain!], [
    { at: 'terminal', text: 'keel auth totp enable makes a new secret key' },
    { from: 'terminal', to: 'app', text: 'You scan the QR code (or type the key)', dash: true },
    { at: 'app', text: 'Shows a new 6-digit code every 30 seconds', tone: 'violet' },
    { from: 'app', to: 'terminal', text: 'You type the code it shows', dash: true },
    { at: 'terminal', text: 'Checks the code, so you know the app is set up right' },
    { from: 'terminal', to: 'keychain', text: 'Saves the key. Codes are on' },
  ]);

const codesSignIn = (t: Theme) =>
  sequence(t, 'Signing in with a code', [LANES.app!, LANES.browser!, LANES.serve!], [
    { from: 'app', to: 'browser', text: 'You read the code and type it', dash: true },
    { from: 'browser', to: 'serve', text: 'The 6-digit code' },
    { at: 'serve', text: 'Reads the key from the Keychain and works out the right code for now (30 seconds either side is fine)', tone: 'blue' },
    { at: 'serve', text: 'Refuses a code that was already used. After 5 wrong codes in a minute: wait a minute', tone: 'red' },
    { from: 'serve', to: 'browser', text: 'Session cookie: 12 hours' },
  ]);

function requests(t: Theme): string {
  const k = kit(t);
  let s = '';
  const box = (x: number, y: number, w: number, text: string, color: Color, fill: Color = 'panel') => {
    const rows = wrap(text, w - 24, 12.5);
    const h = rows.length * 17 + 20;
    s += k.rect(x, y, w, h, { fill, stroke: color });
    s += k.lines(x + w / 2, y + 8, rows, { size: 12.5, anchor: 'middle', gap: 17 }).svg;
    return h;
  };
  const diamond = (cx: number, cy: number, text: string) => {
    s += `<polygon points="${cx},${cy - 34} ${cx + 120},${cy} ${cx},${cy + 34} ${cx - 120},${cy}" fill="${t.panel}" stroke="${t.accent}" stroke-width="1.5"/>`;
    s += k.lines(cx, cy - 16, wrap(text, 170, 12.5), { size: 12.5, anchor: 'middle', weight: 700, gap: 16 }).svg;
  };
  const yes = (x: number, y: number) => k.text(x, y, 'yes', { size: 11, weight: 700, fill: 'green' });
  const no = (x: number, y: number) => k.text(x, y, 'no', { size: 11, weight: 700, fill: 'red' });
  const cx = 230;
  box(cx - 130, 18, 260, 'A request reaches keel serve', 'blue');
  s += k.arrow(cx, 58, cx, 84);
  diamond(cx, 120, 'Started with --public-url or --host?');
  s += k.arrow(cx + 120, 120, 488, 120) + no(cx + 128, 112);
  box(490, 100, 210, 'Answer it. No login (plain keel serve)', 'green');
  s += k.arrow(cx, 154, cx, 184) + yes(cx + 8, 172);
  diamond(cx, 220, 'A page, or a sign-in call?');
  s += k.arrow(cx + 120, 220, 488, 220) + yes(cx + 128, 212);
  box(490, 196, 210, 'Answer it, so the sign-in page can load', 'green');
  s += k.arrow(cx, 254, cx, 284) + no(cx + 8, 272);
  diamond(cx, 320, 'Has a live session cookie?');
  s += k.arrow(cx + 120, 320, 488, 320) + yes(cx + 128, 312);
  box(490, 296, 210, 'Answer it. A Goals session renews for 30 more days', 'green');
  s += k.arrow(cx, 354, cx, 384) + no(cx + 8, 372);
  const last = box(cx - 150, 386, 300, '401 Sign in first. The page shows the sign-in screen: "Your session ended"', 'red');
  return frame(t, 386 + last + 18, s, 'How keel serve decides whether a request needs a login');
}

function sessions(t: Theme): string {
  const k = kit(t);
  let s = '';
  const left = 210;
  const scale = (hours: number) => left + (hours <= 12 ? (hours / 12) * 150 : 150 + ((hours - 12) / (30 * 24 - 12)) * 320);
  const rows: { label: string; sub: string; hours: number; color: Color; note: string }[] = [
    { label: 'Browser terminal', sub: 'passkey', hours: 12, color: 'accent', note: '12 hours' },
    { label: 'Any code sign-in', sub: 'terminal or Goals', hours: 12, color: 'violet', note: '12 hours' },
    { label: 'Goals', sub: 'passkey', hours: 30 * 24, color: 'teal', note: '30 days, renewed while you use it' },
  ];
  rows.forEach((row, i) => {
    const y = 34 + i * 62;
    s += k.text(20, y + 16, row.label, { weight: 700 }) + k.text(20, y + 33, row.sub, { size: 11, fill: 'muted' });
    s += k.rect(left, y + 4, scale(row.hours) - left, 26, { fill: row.color, r: 6 });
    s += k.text(scale(row.hours) - 10, y + 22, row.note, { size: 11.5, weight: 700, fill: t.bg, anchor: 'end' });
  });
  const axis = 34 + rows.length * 62;
  s += `<line x1="${left}" y1="${axis}" x2="${scale(720)}" y2="${axis}" stroke="${t.line}" stroke-width="2"/>`;
  for (const [h, label] of [
    [0, 'sign in'],
    [12, '12 h'],
    [24 * 7, '1 week'],
    [24 * 30, '30 days'],
  ] as const) {
    s += `<line x1="${scale(h)}" y1="${axis - 4}" x2="${scale(h)}" y2="${axis + 4}" stroke="${t.muted}" stroke-width="2"/>`;
    s += k.text(scale(h), axis + 20, label, { size: 11, fill: 'muted', anchor: h === 0 ? 'start' : h === 720 ? 'end' : 'middle' });
  }
  s += k.text(20, axis + 50, 'After that, the next command shows the sign-in screen. Nothing is lost: only the login ends.', { size: 12, fill: 'muted' });
  return frame(t, axis + 70, s, 'How long sessions last');
}

function ending(t: Theme): string {
  const k = kit(t);
  const cols = ['Passkey sessions', 'Code sessions', 'Stops future sign-ins'];
  const rows: [string, string, string, string][] = [
    ['keel auth passkey remove "My iPhone"', "that phone's", 'no', 'with that passkey'],
    ['keel auth sessions revoke --all', 'all', 'all', 'no'],
    ['keel auth sessions revoke <id>', 'that one', 'that one', 'no'],
    ['keel auth totp disable', 'no', 'all', 'with codes'],
    ['Sign out (in the browser)', "this browser's", "this browser's", 'no'],
  ];
  let s = '';
  const x0 = 300;
  const cw = 136;
  cols.forEach((col, i) => (s += k.text(x0 + i * cw + cw / 2, 34, col, { size: 12, weight: 700, anchor: 'middle', fill: 'muted' })));
  rows.forEach((row, r) => {
    const y = 50 + r * 46;
    s += k.rect(14, y, W - 28, 38, { fill: r % 2 ? 'bg' : 'panel', stroke: 'line', r: 8, width: 1 });
    s += k.text(28, y + 24, row[0], { size: 11.5, mono: true });
    row.slice(1).forEach((cell, i) => {
      const cx = x0 + i * cw + cw / 2;
      const color: Color = cell === 'no' ? 'line' : i === 2 ? 'red' : 'accent';
      const w = Math.min(cw - 14, cell.length * 7 + 22);
      s += k.rect(cx - w / 2, y + 8, w, 22, { fill: color, r: 11 });
      s += k.text(cx, y + 23, cell, { size: 11, weight: 700, fill: cell === 'no' ? t.muted : t.bg, anchor: 'middle' });
    });
  });
  return frame(t, 50 + rows.length * 46 + 14, s, 'What each command ends');
}

function addresses(t: Theme): string {
  const k = kit(t);
  let s = '';
  const card = (x: number, title: string, url: string, passkey: boolean, sub: string) => {
    s += k.rect(x, 18, 330, 150, { fill: 'panel', stroke: passkey ? 'green' : 'line' });
    s += k.text(x + 18, 46, title, { size: 14, weight: 700 }) + k.text(x + 18, 68, url, { size: 11.5, mono: true, fill: 'muted' });
    const row = (y: number, ok: boolean, text: string) => {
      s += `<circle cx="${x + 28}" cy="${y - 4}" r="9" fill="${ok ? t.green : t.red}"/>`;
      s += k.text(x + 28, y, ok ? '✓' : '×', { size: 12, weight: 700, fill: t.bg, anchor: 'middle' });
      s += k.text(x + 46, y, text, { size: 13 });
    };
    row(102, passkey, passkey ? 'Passkeys work' : "Passkeys don't work here");
    row(130, true, 'Codes work (when turned on)');
    s += k.text(x + 18, 156, sub, { size: 11, fill: 'muted' });
  };
  card(18, 'The --public-url address', 'https://my-mac.tail1234.ts.net', true, 'A passkey belongs to this one name.');
  card(372, 'Any other address', 'localhost, 127.0.0.1, 192.168.x.x', false, 'The page links you to the right address.');
  return frame(t, 186, s, 'Passkeys only work at the public address; codes work anywhere');
}

function lostPhone(t: Theme): string {
  const k = kit(t);
  const steps: { cmd: string; text: string; color: Color }[] = [
    { cmd: 'keel auth passkey remove "My iPhone"', text: 'The passkey stops working and its sessions end', color: 'red' },
    { cmd: 'keel auth sessions revoke --all', text: 'Also ends code sign-ins, on every device', color: 'accent' },
    { cmd: 'keel auth passkey add --name "New phone"', text: 'Pair the new (or found) phone', color: 'green' },
  ];
  let s = '';
  const w = 214;
  steps.forEach((step, i) => {
    const x = 18 + i * (w + 21);
    s += k.rect(x, 18, w, 130, { fill: 'panel', stroke: step.color });
    s += k.badge(x + 24, 42, i + 1, step.color);
    s += k.lines(x + 14, 64, wrap(step.cmd, w - 28, 11, true), { size: 11, mono: true, gap: 15 }).svg;
    s += k.lines(x + 14, 102, wrap(step.text, w - 28, 12.5), { size: 12.5, fill: 'muted' }).svg;
    if (i < steps.length - 1) s += k.arrow(x + w + 2, 83, x + w + 19, 83);
  });
  return frame(t, 166, s, 'Lost phone: remove its passkey, end code sessions, pair again');
}

const DIAGRAMS: Record<string, (t: Theme) => string> = {
  overview,
  modes,
  pairing,
  'sign-in': signIn,
  'codes-setup': codesSetup,
  'codes-sign-in': codesSignIn,
  requests,
  sessions,
  ending,
  addresses,
  'lost-phone': lostPhone,
};

/** Writes images/login/<name>-light.svg and -dark.svg. */
export function writeDiagrams(site: string): void {
  const dir = join(site, 'images', 'login');
  mkdirSync(dir, { recursive: true });
  for (const [name, draw] of Object.entries(DIAGRAMS)) {
    for (const mode of ['light', 'dark'] as const) writeFileSync(join(dir, `${name}-${mode}.svg`), draw(theme(mode)));
  }
}
