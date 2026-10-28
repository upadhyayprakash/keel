import { palettes, type ThemeName } from '@keel/core/ui';

export function systemTheme(): ThemeName {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Writes the palette into CSS variables, with the same names as the browser terminal. */
export function applyTheme(name: ThemeName): void {
  const { tones, ui } = palettes[name];
  const root = document.documentElement.style;
  for (const [tone, color] of Object.entries(tones)) root.setProperty(`--t-${tone}`, color);
  root.setProperty('--page', ui.page);
  root.setProperty('--bg', ui.bg);
  root.setProperty('--panel', ui.panel);
  root.setProperty('--line', ui.line);
  root.setProperty('--selection', ui.selection);
  root.setProperty('--on-accent', ui.onAccent);
  root.setProperty('--accent-tint', ui.accentTint);
  root.setProperty('--wait-tint', ui.waitTint);
  document.documentElement.style.colorScheme = name;
}
