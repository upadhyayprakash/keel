import type { Tone } from './blocks';

export type ThemeName = 'light' | 'dark';
export type ThemeSetting = ThemeName | 'auto';

export interface Palette {
  /** Text colors per tone. `default` is only used by the browser; the CLI keeps the terminal's own foreground. */
  tones: Record<Tone, string>;
  /** Surface colors for the browser terminal. */
  ui: { page: string; bg: string; panel: string; line: string; selection: string; onAccent: string };
}

// Every tone keeps at least 4.5:1 contrast on its background.
export const palettes: Record<ThemeName, Palette> = {
  dark: {
    tones: {
      default: '#E2E8F0',
      muted: '#94A3B8',
      dim: '#7C8BA1',
      accent: '#FB923C',
      late: '#F87171',
      today: '#FBBF24',
      wait: '#93C5FD',
      done: '#4ADE80',
      teal: '#5EEAD4',
      violet: '#C4B5FD',
      pink: '#F9A8D4',
      sky: '#7DD3FC',
      lime: '#BEF264',
      amber: '#FCD34D',
    },
    ui: { page: '#05080F', bg: '#0B1220', panel: '#111A2E', line: '#1E293B', selection: '#1E293B', onAccent: '#0B1220' },
  },
  light: {
    tones: {
      default: '#0F1A2A',
      muted: '#4B5563',
      dim: '#5B6576',
      accent: '#C2410C',
      late: '#B42318',
      today: '#A15C07',
      wait: '#1D4ED8',
      done: '#067647',
      teal: '#0E7490',
      violet: '#6D28D9',
      pink: '#BE185D',
      sky: '#0369A1',
      lime: '#4D7C0F',
      amber: '#92400E',
    },
    ui: { page: '#D5DBE3', bg: '#F8FAFC', panel: '#EEF2F6', line: '#DDE2E8', selection: '#E2E8F0', onAccent: '#FFFFFF' },
  },
};

/** Client colors are assigned from this list in order. */
export const CLIENT_HUES: Tone[] = ['teal', 'violet', 'pink', 'sky', 'lime', 'amber'];
