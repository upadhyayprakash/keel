# Keel brand assets

Free to use when referring to Keel (in articles, packages, forks that credit the project). Please don't use them to make something look like an official Keel release when it isn't.

## Logos

| File | Use |
|---|---|
| `keel-wordmark.svg` | The brand: `› keel` wordmark, for light backgrounds |
| `keel-wordmark-dark.svg` | The same, for dark backgrounds |
| `keel-icon.svg` | App icon and favicon: `›k` on ink. Also used by the browser terminal |
| `keel-mark-cli.svg` | The hull-and-keel mark. Terminal contexts only (CLI docs, banner art) |
| `keel-social.svg` | GitHub social preview, 1280x640 |
| `png/` | PNG exports of all of the above |

The wordmark is drawn as strokes, not live text, so it looks the same everywhere. Keep the chevron orange and the letters ink (or white on dark). Give it clear space of at least the height of the `e` on every side.

## CLI banner

- `cli-banner.txt`: shown by `keel` with no arguments. The waterline row is printed in the accent color.
- `cli-banner-ascii.txt`: plain ASCII fallback for terminals without Unicode.

The banner also lives in `apps/cli/src/terminal.ts`. Change both together.

## Colors

| Name | Light | Dark | Use |
|---|---|---|---|
| Ink | `#0F1A2A` | `#F8FAFC` | Text, wordmark letters |
| Navy | `#12355B` | | CLI mark |
| Signal (accent) | `#C2410C` | `#FB923C` | Chevron, prompts, focus |
| Late | `#B42318` | `#F87171` | Overdue |
| Today | `#A15C07` | `#FBBF24` | Due today |
| Waiting | `#1D4ED8` | `#93C5FD` | Waiting on |
| Done | `#067647` | `#4ADE80` | Done, kept |

Every text color keeps at least 4.5:1 contrast on its background. The full palettes live in `packages/core/src/palettes.ts`.

## Type

- **JetBrains Mono** for the terminals.
- **Space Grotesk** for display text, when a page needs it.

## Regenerating the PNGs

```bash
cd assets/brand
rsvg-convert -h 352 keel-wordmark.svg -o png/keel-wordmark@4x.png
rsvg-convert -w 512 -h 512 keel-icon.svg -o png/keel-icon-512.png
rsvg-convert -w 1280 -h 640 keel-social.svg -o png/keel-social.png
```

The README screenshots (`png/keel-cli-welcome.png`, `png/keel-browser.png`) come from the real CLI and browser terminal, with fictional sample data. After `pnpm build`, from the repo root (needs Google Chrome):

```bash
node assets/brand/render-cli.mjs
```
