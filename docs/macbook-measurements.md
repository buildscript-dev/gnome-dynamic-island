# MacBook Dynamic Island: measurements

The **MacBook** style is tuned to Apple's MacBook Pro with PROLED XDR Display
(announced October 2026, shipping November 6, 2026). Only measured numbers are
used here; no Apple code, images or other assets are included in this project.

## Method

1. `rea` (REA 6.8.0) attached over CDP to a headless Chromium on loopback and
   passively inspected `apple.com/macbook-pro/` and
   `apple.com/macbook-pro/proled-xdr-display/` (`list-browser-targets`,
   `inspect-web-page`). The page's Dynamic Island section is a gallery of
   **still images** (highlight, Spotlight, Live Activities, Siri), not videos.
2. The stills were measured locally with brightness profiles across the island
   (rows and columns through its centre), in units of the macOS menu bar height
   so the ratios carry over to any screen.

## Findings

| Property | Measurement |
|---|---|
| Position | Hangs from the top edge of the screen. The top is flat and merges with the bezel; only the bottom corners are rounded. |
| Menu bar | Stays visible on both sides of the island. In the Live Activity still the menu bar is ~36 px and the island starts at the same top edge. |
| Bottom corner radius | ~0.155 × island height (AirDrop card 23/147 px, music card 45/295 px). |
| Expanded card shape | ~1.6 : 1 width to height (AirDrop 229×147, music 480×295). |
| AirDrop card | ~6.4 × menu bar wide, ~4.1 × menu bar tall. |
| Spotlight | The island widens into a ~5.5 : 1 search bar (~2.2 × menu bar tall) with a separate frosted results panel below it. The bar is not pure black: it fades from near black at the top to dark grey at the bottom. |
| Music player | Stacked: art + title/artist + waveform on top, full-width scrubber with elapsed / remaining time, then large previous / play-pause / next. |
| Camera | A small lens sits at the top centre inside the island. |

## Not measured yet

Motion (spring stiffness, damping, open/close timing) and the resting compact
size: the product page has no video of the island. These will be measured from
real footage after the device ships; until then the island keeps the springs
fitted to iPhone footage in omarchy-dynamic-island.

## How the extension uses this (`lib/model.js`, `MACBOOK`)

- `style = macbook`: flat top at the screen edge, bottom radius
  `max(0.155 × h, min(0.4 × h, 14))`.
- Expanded player: 435 × 272 (1.6 : 1), stacked layout.
- With the top bar shown, the island is exactly the bar's height and takes over
  the clock, like the island in the macOS menu bar.
