# ZUULI brand assets

`logo.svg` is the durable application-mark master and is read, never synthesized,
by the generator. Its geometry and palette are checked against the established
shielded `Z` in `src/components/brand/Logo.tsx`; platform rounding belongs to
the operating system, not the square master.

The other files in this directory and every raster under `assets/store/`,
`public/`, `src-tauri/icons/`, and the generated native projects are derived by:

```bash
npm run icons:generate
```

Do not hand-edit generated PNG, ICO, or ICNS files. `npm run icons:check`
regenerates them in a temporary directory and verifies output drift, exact
dimensions, RGB-only store/iOS assets, every ICO/ICNS representation, the
Android adaptive-icon safe zone, round and monochrome variants, and application
configuration wiring. Its mutation self-tests prove malformed generator output
is rejected, so CI does not treat `tauri icon` success as an asset verdict.

The Tauri 2.11.4 icon generator currently emits a suspicious 49 px legacy
Android `hdpi` icon, can retain an alpha channel in iOS PNGs, and emits ICNS
chunks in a nondeterministic order. The generator therefore uses Tauri for its
desktop/native set, canonicalizes the ICNS container, deterministically renders
the Android density matrix, and normalizes Apple images to RGB before validation.
