# Free2Z Docs (VitePress)

Product documentation for Free2Z. Brand colors, surfaces, and interaction patterns mirror the `ts/svelte/free2z` design system (lime accent, neutral glass cards, dark by default).

## Develop

Use Node 24.22.1 and the committed dependency lockfile.

```bash
cd docs/free2z/website
npm ci --ignore-scripts
npm run dev
```

Dev server defaults to [http://localhost:5174](http://localhost:5174).

## Build

```bash
npm run build
npm run preview
```

VitePress uses the scoped Vite 6.4.4 override to include patched development-server
dependencies. Verify `npm audit`, the build, and local development when changing it.

## Structure

| Path | Content |
| --- | --- |
| `index.md` | Home — discover, create, connect, and earn |
| `getting-started/` | Onboarding and the central Tuzis guide |
| `features/` | Publishing, translation, Converse, livestreams, and SDK discovery |
| `guides/` | Compact help index; existing guide URLs remain available |
| `for-creators/` | Publish, live, boost, AI |
| `for-supporters/` | Discover, tip, subscribe |
| `overview/` | What / why Free2Z |
| `privacy/` | Anons + Zcash |
| `revenue-sharing/` | Separate usage-credit and creator-compensation model |
| `legal/` | Entry points to formal policies |
| `.vitepress/theme/` | Free2Z theme, tokens, custom Vue components |

## Theme components

Registered in `.vitepress/theme/index.ts` for use in Markdown:

- `F2zCard` / `F2zCardGrid` — glass nav cards
- `F2zPath` — role / path picker rows
- `F2zSteps` — numbered onboarding steps
- `F2zLinkRow` — compact guide lists
- `F2zCta` — CTA banner (matches the Svelte HomeCTA vibe)
- `F2zBadge` — mono uppercase pill

## Design tokens

Source of truth for the app: `ts/svelte/free2z/src/styles/globals.css`.  
Docs theme maps the same `--f2z-*` variables into VitePress `--vp-c-*` tokens in `.vitepress/theme/style.css`.

## Product screenshots

`public/product/` contains unchanged anonymous browser captures of the public app. `provenance.json` records each URL, capture time, frontend revision, dimensions, and SHA-256. The screenshots do not show account, earnings, or payment screens.
