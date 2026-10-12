import { describe, expect, it } from 'vitest';
import { classify, parseRef, tokenize } from '../src/parse';

describe('tokenize', () => {
  it('keeps quoted text together and marks it literal', () => {
    expect(tokenize('client new acme "Acme Corp"')).toEqual([
      { text: 'client', quoted: false },
      { text: 'new', quoted: false },
      { text: 'acme', quoted: false },
      { text: 'Acme Corp', quoted: true },
    ]);
  });

  it('supports quoted values after key:', () => {
    expect(tokenize('park where:"pricing done" next:\'send deck\'').map((t) => t.text)).toEqual([
      'park',
      'where:pricing done',
      'next:send deck',
    ]);
  });

  it('leaves apostrophes inside words alone', () => {
    expect(tokenize("in don't forget Ravi's deck").map((t) => t.text)).toEqual(['in', "don't", 'forget', "Ravi's", 'deck']);
  });
});

describe('classify', () => {
  it('sorts tokens into people, projects, tags, key:values and words', () => {
    const p = classify(tokenize('send pricing deck @Ravi +acme/website due:thu from:slack:https://x.slack.com/a #legal --json'));
    expect(p.words).toEqual(['send', 'pricing', 'deck']);
    expect(p.people).toEqual(['ravi']);
    expect(p.projects).toEqual(['acme/website']);
    expect(p.tags).toEqual(['legal']);
    expect(p.kv).toEqual({ due: 'thu', from: 'slack:https://x.slack.com/a' });
    expect([...p.flags]).toEqual(['json']);
  });

  it('treats unknown key:value and URLs as words', () => {
    expect(classify(tokenize('re:budget https://example.com')).words).toEqual(['re:budget', 'https://example.com']);
  });

  it('never classifies quoted tokens', () => {
    expect(classify(tokenize('"@ravi due:thu"')).words).toEqual(['@ravi due:thu']);
  });
});

describe('parseRef', () => {
  it('reads c/p/i refs', () => {
    expect(parseRef('c42')).toEqual({ kind: 'c', n: 42 });
    expect(parseRef('P7')).toEqual({ kind: 'p', n: 7 });
    expect(parseRef('x1')).toBeNull();
    expect(parseRef(undefined)).toBeNull();
  });
});
