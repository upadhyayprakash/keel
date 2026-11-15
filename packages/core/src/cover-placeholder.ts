// ADR 0005, section 4: a list with no cover shows this built-in placeholder (a picture
// frame with a sun and mountains), in a light and a dark version that follow the theme.
// It is part of the app, not stored per list. Browser-safe: strings only.

export const COVER_PLACEHOLDER = {
  light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 320">
  <title>Default list cover</title>
  <g stroke="#0F1A2A" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
    <path d="M70 190 C40 110 130 40 240 50 C340 24 480 44 505 125 C530 205 450 292 330 288 C230 304 90 280 70 190Z" fill="#EEF2F6" stroke="none"/>
    <rect x="170" y="80" width="220" height="160" rx="18" fill="#F8FAFC"/>
    <circle cx="228" cy="132" r="18" fill="#FBBF24"/>
    <path d="M170 214 L240 160 L282 196 L322 150 L390 214 V222 a18 18 0 0 1 -18 18 H188 a18 18 0 0 1 -18 -18Z" fill="#93C5FD"/>
    <path d="M240 160 L282 196 L322 150" fill="none" stroke-width="3"/>
    <path d="M110 120 v20 M100 130 h20 M450 80 v16 M442 88 h16" fill="none" stroke="#5B6576" stroke-width="3"/>
  </g>
</svg>`,
  dark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 320">
  <title>Default list cover (dark)</title>
  <g stroke="#CBD5E1" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
    <path d="M70 190 C40 110 130 40 240 50 C340 24 480 44 505 125 C530 205 450 292 330 288 C230 304 90 280 70 190Z" fill="#111A2E" stroke="none"/>
    <rect x="170" y="80" width="220" height="160" rx="18" fill="#0B1220"/>
    <circle cx="228" cy="132" r="18" fill="#FBBF24"/>
    <path d="M170 214 L240 160 L282 196 L322 150 L390 214 V222 a18 18 0 0 1 -18 18 H188 a18 18 0 0 1 -18 -18Z" fill="#3B6FB6"/>
    <path d="M240 160 L282 196 L322 150" fill="none" stroke-width="3"/>
    <path d="M110 120 v20 M100 130 h20 M450 80 v16 M442 88 h16" fill="none" stroke="#7C8BA1" stroke-width="3"/>
  </g>
</svg>`,
} as const;
