# Free2Z documentation

This site uses Docusaurus 3.10 and builds the public Free2Z documentation.
Use Node 24.22.1, matching the website build pipeline; the supported minimum
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
