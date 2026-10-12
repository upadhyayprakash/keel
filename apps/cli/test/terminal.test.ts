import { describe, expect, it } from 'vitest';
import { classify, tokenize } from '@keel/core';
import { ansiPaint, argvToLine, resolveTheme, useColor } from '../src/terminal';

describe('argvToLine', () => {
  it('re-quotes arguments the shell unquoted, keeping key:value shape', () => {
    const line = argvToLine(['park', 'where:pricing copy done', 'next:send deck', '+acme/website']);
    expect(line).toBe('park where:"pricing copy done" next:"send deck" +acme/website');
    expect(classify(tokenize(line)).kv).toEqual({ where: 'pricing copy done', next: 'send deck' });
  });

  it('quotes plain text with spaces as one literal word', () => {
    expect(argvToLine(['client', 'new', 'acme', 'Acme Corp'])).toBe('client new acme "Acme Corp"');
    expect(argvToLine(['in', 'say "hi" to Ravi'])).toBe(`in 'say "hi" to Ravi'`);
  });
});

describe('resolveTheme', () => {
  it('prefers KEEL_THEME, then the saved setting', () => {
    expect(resolveTheme({ KEEL_THEME: 'light' }, 'dark')).toBe('light');
    expect(resolveTheme({}, 'light')).toBe('light');
  });

  it('detects the background from COLORFGBG, else dark', () => {
    expect(resolveTheme({ COLORFGBG: '0;15' }, 'auto')).toBe('light');
    expect(resolveTheme({ COLORFGBG: '15;default;0' }, null)).toBe('dark');
    expect(resolveTheme({}, null)).toBe('dark');
  });
});

describe('colors', () => {
  it('respects NO_COLOR and pipes', () => {
    expect(useColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(useColor({}, false)).toBe(false);
    expect(useColor({}, true)).toBe(true);
  });

  it('paints tones in truecolor and leaves default text alone', () => {
    const paint = ansiPaint('dark');
    expect(paint('late', { tone: 'late' })).toBe('\x1b[38;2;248;113;113mlate\x1b[0m');
    expect(paint('plain', { tone: 'default' })).toBe('plain');
  });
});
