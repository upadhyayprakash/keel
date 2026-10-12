import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '@keel/core';
import { completionScript, formatSuggestions } from '../src/completion';
import { needsProbe, parseBackgroundReply, resolveTheme } from '../src/terminal';

describe('version', () => {
  it('matches the published package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('shell completion', () => {
  const suggestions = [
    { insert: 'due:thu', label: 'due:thu', detail: 'Thu 15 Oct' },
    { insert: '@ravi', label: '@ravi' },
  ];

  it('escapes colons for zsh and adds descriptions', () => {
    expect(formatSuggestions('zsh', suggestions)).toBe('due\\:thu:Thu 15 Oct\n@ravi');
  });

  it('prints bare values for bash', () => {
    expect(formatSuggestions('bash', suggestions)).toBe('due:thu\n@ravi');
  });

  it('has a script for each shell that calls back into keel', () => {
    expect(completionScript('zsh')).toContain('compdef _keel keel');
    expect(completionScript('bash')).toContain('complete -F _keel keel');
    expect(completionScript('zsh')).toContain('keel __complete zsh');
  });
});

describe('terminal background (OSC 11)', () => {
  it('reads light and dark replies', () => {
    expect(parseBackgroundReply('\x1b]11;rgb:ffff/ffff/ffff\x07')).toBe('light');
    expect(parseBackgroundReply('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toBe('dark');
    expect(parseBackgroundReply('\x1b]11;rgb:fa/f8/f2\x07')).toBe('light');
    expect(parseBackgroundReply('garbage')).toBeNull();
  });

  it('only asks when nothing else decided the theme', () => {
    expect(needsProbe({}, 'auto')).toBe(true);
    expect(needsProbe({}, 'light')).toBe(false);
    expect(needsProbe({ KEEL_THEME: 'dark' }, 'auto')).toBe(false);
    expect(needsProbe({ COLORFGBG: '0;15' }, 'auto')).toBe(false);
  });

  it('uses the reply after COLORFGBG and before the dark default', () => {
    expect(resolveTheme({}, 'auto', 'light')).toBe('light');
    expect(resolveTheme({}, 'auto', null)).toBe('dark');
    expect(resolveTheme({ COLORFGBG: '15;0' }, 'auto', 'light')).toBe('dark');
  });
});

describe('banner', () => {
  it('shows keel-prefixed commands outside the shell and bare ones inside', async () => {
    const { banner } = await import('../src/terminal');
    const plain = (text: string) => text;
    expect(banner(plain, '1.0.0', 'local')).toContain('keel serve');
    const shell = banner(plain, '1.0.0', 'local', { shell: true });
    expect(shell).toContain('exit             leave (or Ctrl+D)');
    expect(shell).not.toContain('keel serve');
  });
});
