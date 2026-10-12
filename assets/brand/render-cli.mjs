// Renders the README screenshots into png/ (2x), using the real CLI and browser terminal:
//   keel-cli-welcome.png  the `keel` welcome screen, dark theme
//   keel-browser.png      `keel serve` showing `today` with sample data, light theme
// Usage, from the repo root after `pnpm build` (needs Google Chrome):
//   node assets/brand/render-cli.mjs
// Everything runs against a throwaway database with fictional clients (Acme, Northwind).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4399;
const png = (name) => fileURLToPath(new URL(`./png/${name}`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'keel-shot-'));
const env = { ...process.env, KEEL_DB_URL: `file:${join(scratch, 'keel.db')}`, KEEL_BACKUP_KEEP: '0', KEEL_THEME: 'dark', FORCE_COLOR: '1' };
const keel = (...args) => execFileSync('pnpm', ['-s', 'keel', ...args], { encoding: 'utf8', env });

function screenshot(url, out, width, height, extra = []) {
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      ...extra,
      url,
    ],
    { stdio: 'ignore' },
  );
  console.log(`Wrote ${out}`);
}

/** The CLI only emits bold (1), reset (0) and truecolor foreground (38;2;r;g;b). */
function ansiToHtml(ansi) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  let open = false;
  for (const part of ansi.trimEnd().split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) {
      html += escape(part);
      continue;
    }
    if (open) html += '</span>';
    open = false;
    const codes = m[1].split(';').map(Number);
    if (codes[0] === 0) continue;
    let style = '';
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 1) style += 'font-weight:700;';
      if (codes[i] === 38 && codes[i + 1] === 2) {
        style += `color:rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]});`;
        i += 4;
      }
    }
    html += `<span style="${style}">`;
    open = true;
  }
  return open ? `${html}</span>` : html;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('keel serve did not start');
}

let server;
try {
  // 1. CLI welcome screen
  const page = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    .window { display: inline-block; margin: 24px; background: #0B1220; border-radius: 12px; overflow: hidden;
      box-shadow: 0 0 0 1px #1E293B, 0 14px 30px rgba(0,0,0,.30); }
    .bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #111A2E; border-bottom: 1px solid #1E293B; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .title { flex: 1; text-align: center; margin-right: 52px; color: #94A3B8; font: 12px Menlo, monospace; }
    pre { margin: 0; padding: 18px 28px 20px 22px; color: #E2E8F0; font: 14px/1.35 Menlo, monospace; }
    .prompt { color: #5EEAD4; }
  </style><div class="window"><div class="bar"><span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span><span class="title">keel</span></div><pre><span class="prompt">$</span> keel\n${ansiToHtml(keel())}</pre></div>`;
  const file = join(scratch, 'cli.html');
  writeFileSync(file, page);
  screenshot(`file://${file}`, png('keel-cli-welcome.png'), 696, 470, ['--default-background-color=00000000']);

  // 2. Browser terminal with a believable day
  for (const line of [
    ['client', 'new', 'acme', 'Acme Corp'],
    ['client', 'new', 'northwind', 'Northwind'],
    ['project', 'new', 'acme/website', 'Website rebuild'],
    ['project', 'new', 'northwind/portal', 'Customer portal'],
    ['owe', 'send', 'pricing', 'deck', '@ravi', 'due:today', 'from:meeting'],
    ['owe', 'review', 'homepage', 'copy', '@priya', 'due:tomorrow'],
    ['wait', 'design', 'files', '@meera', 'due:today'],
    ['owe', 'send', 'revised', 'SOW', '@ravi', 'due:+2d', '+northwind/portal', 'from:slack:https://example.slack.com/archives/C1/p2'],
    ['wait', 'API', 'keys', '@tom', 'due:today', '+northwind/portal'],
    ['in', 'ask', 'about', 'the', 'phase', '2', 'budget'],
    ['focus', 'c1', 'c2'],
    ['theme', 'light'],
  ]) {
    keel(...line);
  }
  server = spawn('pnpm', ['-s', 'keel', 'serve', '--port', String(PORT)], { env, stdio: 'ignore', detached: true });
  await waitForServer();
  // The page runs `today` on load; the virtual time budget lets that finish before the shot.
  screenshot(`http://localhost:${PORT}/`, png('keel-browser.png'), 1100, 560, ['--virtual-time-budget=4000']);
} finally {
  if (server) process.kill(-server.pid);
  rmSync(scratch, { recursive: true, force: true });
}
