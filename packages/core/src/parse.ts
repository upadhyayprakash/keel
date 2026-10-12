// The command language shared by the CLI and the browser terminal.
// Tokens follow todo.txt conventions: @person, +client/project, #tag, key:value.

export interface Token {
  text: string;
  /** True when the token started with a quote, so it is always a literal word. */
  quoted: boolean;
}

export const KV_KEYS = ['due', 'from', 'status', 'title', 'where', 'next', 'unsure', 'theme', 'slug'] as const;
export type KvKey = (typeof KV_KEYS)[number];

export interface Parsed {
  words: string[];
  people: string[];
  projects: string[];
  tags: string[];
  kv: Partial<Record<KvKey, string>>;
  flags: Set<string>;
  /** Every token's text, in order, for commands that take free text. */
  raw: Token[];
}

export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let cur = '';
  let started = false;
  let quotedStart = false;
  let quote: string | null = null;

  const push = () => {
    if (started) out.push({ text: cur, quoted: quotedStart });
    cur = '';
    started = false;
    quotedStart = false;
  };

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    // A quote only opens at the start of a token or right after `key:`,
    // so apostrophes in words ("don't") stay literal.
    if ((ch === '"' || ch === "'") && (cur === '' || cur.endsWith(':'))) {
      if (!started) quotedStart = true;
      started = true;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
    started = true;
  }
  push();
  return out;
}

export function classify(tokens: Token[]): Parsed {
  const p: Parsed = { words: [], people: [], projects: [], tags: [], kv: {}, flags: new Set(), raw: tokens };
  for (const t of tokens) {
    const text = t.text;
    if (t.quoted) {
      p.words.push(text);
      continue;
    }
    if (/^@[\w.-]+$/.test(text)) p.people.push(text.slice(1).toLowerCase());
    else if (/^\+[a-z0-9][\w-]*(\/[a-z0-9][\w-]*)?$/i.test(text)) p.projects.push(text.slice(1).toLowerCase());
    else if (/^#[\w-]+$/.test(text)) p.tags.push(text.slice(1).toLowerCase());
    else if (/^--[a-z][\w-]*$/.test(text)) p.flags.add(text.slice(2));
    else {
      const kv = /^([a-z]+):(.*)$/s.exec(text);
      const key = kv?.[1] as KvKey | undefined;
      if (kv && key && (KV_KEYS as readonly string[]).includes(key)) p.kv[key] = kv[2] ?? '';
      else p.words.push(text);
    }
  }
  return p;
}

export function parseRef(text: string | undefined): { kind: 'c' | 'p' | 'i'; n: number } | null {
  const m = /^([cpi])(\d+)$/i.exec(text ?? '');
  if (!m) return null;
  return { kind: m[1]!.toLowerCase() as 'c' | 'p' | 'i', n: Number(m[2]) };
}
