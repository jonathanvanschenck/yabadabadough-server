# Logo source

Editable, **font-dependent** masters for the Yabadaba Dough mark. These render the
`$` and `YD` as live `<text>` in Archivo / Archivo Black, so they only look right where
those fonts are installed — tweak type/spacing here, then re-export the flattened
(path-only) versions the browser actually uses.

- `font-version/YD-dollar-badge.svg` — mark on the dark rounded-rect badge.
- `font-version/YD-dollar-transparent.svg` — mark alone, transparent background.

## Exported (font-independent) assets in the browser

Outlined copies live under `public/` and are the ones referenced by the app:

- `public/svg/logo-badge.svg` — badge (favicon + login modal).
- `public/svg/logo.svg` — transparent mark (nav bar).
- `public/favicon-{16,32,48,180,192,512}.png` — raster favicons / apple-touch icon.

After editing a master, re-flatten text to paths and regenerate the matching file(s)
above in the same commit.
