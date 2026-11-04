# Free2Z documentation

This site uses Docusaurus 3.10 and builds the public Free2Z documentation.
Use Node 24.22.2, matching the website build pipeline; the supported minimum
is Node 24.15.

Install the committed dependency graph and build the static site:

```sh
npm ci --ignore-scripts
npm run build
```

The build synchronizes the plain-text legal pages and writes the site to
`docsbuild/`. `npm run start` runs the local development server. After a build,
`npm run typecheck` checks the TypeScript sources,
`npm run test:build-dependencies` checks the overridden build APIs, and
`node scripts/check-legal-plain.mjs docsbuild` checks the legal-page output.

Scoped npm overrides select patched versions of Tinypool, Serialize JavaScript,
and UUID where the parent packages request older major versions. Keep the
lockfile committed, and verify a fresh install, the site build, and `npm audit`
when changing these overrides. The Node 24 baseline supports their module APIs.

### Dependency reconciliation (issue #1338)

The build graph uses webpack-dev-server → Express 4.22.3 → body-parser 1.20.9
and qs; both Express and body-parser request qs `~6.16.0`. An override moves qs
6.16.1 to 6.17.1 for [GHSA-w4cr-vjpx-p82q](https://github.com/ljharb/qs/security/advisories/GHSA-w4cr-vjpx-p82q).
The other queued security candidates were already fixed in the lock:
postcss-selector-parser 6.1.5 and 7.1.7 are used by CSS build plugins
([upstream releases](https://github.com/postcss/postcss-selector-parser/releases));
AJV uses fast-uri 3.1.9, the [patched 3.x release](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr).
Body-parser 1.20.9 and Express 4.22.3 are retained; changing their major
versions would change the development server's consumers.
