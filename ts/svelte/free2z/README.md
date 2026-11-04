# Free2Z website

The Svelte application provides publishing, subscriptions, conversations,
account management, and live calls for Free2Z. It uses the Django API in
[`py/free2z`](../../../py/free2z/README.md).

See [local setup](SETUP-GUIDE.md) for the Docker Compose stack. For frontend
commands, use Node 24.15 or newer and install the committed dependency graph:

```sh
npm ci --ignore-scripts
npm run generate:api
npm run dev
```

`npm run check` checks types; `npm test` runs unit contracts; `npm run build`
produces the server application. Generated API clients use
`py/free2z/dj/free2z/openapi/f2z.yaml` as the canonical schema.

## Versioned assets

`PUBLIC_BUILD_SHA` identifies the application source. SvelteKit uses it as a
deterministic version name. Deployments must retain immutable assets needed by
supported open tabs and rollback versions. HTML and page-data responses must
not be cached as immutable; failed asset responses must not be retained.

Asset recovery performs a bounded version check and guarded reload of the same
URL. A shared session-storage guard prevents a persistent missing asset from
causing an infinite refresh loop. Deployment topology and retention policy are
configured outside the application source.

## Browser support

The baseline is declared once, in [`.browserslistrc`](.browserslistrc):
**Chrome/Edge 111+, Firefox 128+, Safari/iOS 16.4+**, which is the floor
Tailwind CSS v4 and our own `@property` / `color-mix()` usage already require.

`vite.config.ts` derives esbuild's `build.target` from that file, so the CSS
and JS floors cannot drift apart. Changing the baseline means editing
`.browserslistrc` and nothing else.

Caveat: this constrains **syntax** only, and the runtime check is best effort,
not a complete browser-baseline guarantee. Runtime APIs newer than the
baseline are invisible to the bundler, so `npm run lint` also runs
`eslint-plugin-compat` with ECMAScript API checks enabled. That plugin is most
reliable for global member chains, while its compatibility metadata and its
analysis of typed variables or instance methods have gaps. The browser search
path uses `createAbortSignalWithTimeout`, a baseline-safe combination of
`AbortController`, abort listeners, and timers, instead of
`AbortSignal.any()` or `AbortSignal.timeout()`.

The local scope-aware rule covers a small list of known gaps:
`Set.prototype.union`, `RegExp.escape`, `Object.groupBy`,
`Promise.withResolvers`, `Array.fromAsync`, `AbortSignal.any`, and
`AbortSignal.timeout`. It reports only when a built-in identity is proven
through direct/global chains, aliases, source-order assignments, static
computed properties, destructuring, constructors, or supported TypeScript Set
types. It intentionally does not infer arbitrary object-property wrappers
(for example `const o = { s: AbortSignal }; o.s.any([])`), every typed-variable
method, or unknown values; those remain unreported. Server-only files are
exempt because they do not run in the browser.

Checkout the [SETUP-GUIDE](SETUP-GUIDE.md) for more information
