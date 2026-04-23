// Palette mirrors the TUI redesign mockup. Hex values go directly into Ink's
// `color` / `borderColor` props — 24-bit truecolor in terminals that support it.
export const theme = {
    fg: '#d7dae5',
    fgDim: '#7a8095',
    fgFaint: '#4a5063',

    // `border` is the visible default for panels in terminal — the very dark
    // `#1f2230` from the web mockup gets crushed against the alt-screen
    // background, so we promote `borderStrong` to the everyday border and keep
    // the dim value as `borderDim` for inner separators.
    border: '#2b2f42',
    borderDim: '#1f2230',
    borderStrong: '#3a3f55',
    borderFocus: '#00e5ff',

    accent: '#00e5ff', // cyan
    magenta: '#ff2bd6',
    lime: '#b6ff3c',
    amber: '#ffb020',
    red: '#ff4d6d',
    green: '#2fd67a',

    // legacy aliases kept for gradual migration
    muted: '#7a8095',
    dim: '#4a5063',
    ok: '#2fd67a',
    warn: '#ffb020',
    err: '#ff4d6d',

    // Modal / overlay fill. Slightly lighter than the terminal default so
    // floating panels stand out against a dark background, but dark enough
    // that the palette (accent/lime/amber) keeps the same contrast it has
    // on bare terminal. Text inside inherits via Ink's BackgroundContext.
    overlayBg: '#141826',
};
