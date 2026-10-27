# Build the adapter-node output separately from its native runtime dependencies.
# SvelteKit is bundled into build/, so the security audit includes development
# dependencies even though the runtime install uses --omit=dev. Native resvg
# remains external and requires the same Alpine/musl base in both stages.
# Explicit Noto font families support multilingual Open Graph cards.
FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS og-fonts
# Alpine 3.24 security floors: CVE-2026-107891 (musl) and CVE-2026-85091
# (zlib). Keep build and runtime on the same patched native libraries.
RUN apk add --no-cache 'ca-certificates>=20261020-r0' 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3' 'zlib>=1.3.2-r1' \
    font-noto-cjk font-noto-arabic font-noto-hebrew \
    font-noto-bengali font-noto-devanagari font-noto-ethiopic font-noto-gujarati \
    font-noto-gurmukhi font-noto-kannada font-noto-khmer font-noto-lao \
    font-noto-malayalam font-noto-myanmar font-noto-sinhala font-noto-tamil \
    font-noto-telugu font-noto-thai \
    && mkdir /og-fonts \
    && for script in Arabic Hebrew Bengali Devanagari Ethiopic Gujarati Gurmukhi Kannada Khmer Lao Malayalam Myanmar Sinhala Tamil Telugu Thai; do \
      for weight in Regular Bold; do \
        cp "/usr/share/fonts/noto/NotoSans${script}-${weight}.ttf" /og-fonts/; \
      done; \
    done \
    && cp /usr/share/fonts/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/noto/NotoSansCJK-Bold.ttc /og-fonts/

# Alpine's emoji package is a bitmap color font; Resvg needs outlines. Pin the
# small upstream monochrome font and its license by commit and checksum.
RUN wget -O /og-fonts/NotoEmoji.ttf 'https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf' \
    && echo 'de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551  /og-fonts/NotoEmoji.ttf' | sha256sum -c - \
    && wget -O /og-fonts/NotoEmoji-OFL.txt 'https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoemoji/OFL.txt' \
    && echo '500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b  /og-fonts/NotoEmoji-OFL.txt' | sha256sum -c -

FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS builder

RUN apk add --no-cache 'ca-certificates>=20261020-r0' 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3' 'zlib>=1.3.2-r1'
ENV NODE_OPTIONS=--use-openssl-ca

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# SvelteKit embeds this deterministic revision in its version endpoint. The
# runtime deployment also exposes the same value through PUBLIC_BUILD_SHA for
# health checks and response observability.
ARG PUBLIC_BUILD_SHA=dev
ENV PUBLIC_BUILD_SHA=$PUBLIC_BUILD_SHA
ENV NODE_OPTIONS="--use-openssl-ca --max-old-space-size=4096"
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime. Same base image, same digest — deliberately; see the musl note above.
# ---------------------------------------------------------------------------
FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

ARG PUBLIC_BUILD_SHA
ENV PUBLIC_BUILD_SHA=$PUBLIC_BUILD_SHA
WORKDIR /app

# Resvg cannot draw any text without system fonts. The minimal Node Alpine
# image has none; install a sans-serif fallback for the social-card renderer.
# Node's bundled store is separate from Alpine's. Use the patched system
# store exclusively for consistent trust across build and runtime.
ENV NODE_OPTIONS=--use-openssl-ca
RUN apk add --no-cache 'ca-certificates>=20261020-r0' 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3' 'zlib>=1.3.2-r1' font-dejavu
COPY --from=og-fonts /og-fonts/ /usr/share/fonts/free2z/

# `npm ci --omit=dev` from the same lockfile the builder used, so the runtime
# dependency versions are exactly the ones the build was verified against.
# `--ignore-scripts` is safe today (this package.json declares no prepare /
# postinstall) and stops a transitive dependency's install script from reaching
# for a devDependency that no longer exists in this stage.
COPY package*.json ./
# The server starts with node directly. Remove inherited package managers and
# their dependency trees after installation; none are needed to serve requests.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# adapter-node output: build/index.js (what `node build` resolves to),
# build/handler.js, build/server/, and build/client/ — which already contains
# everything from static/.
COPY --from=builder /app/build ./build

# Exercise the native rasterizer and runtime fonts in the deployed image.
COPY scripts/check-og-runtime.mjs ./scripts/check-og-runtime.mjs
COPY scripts/og-script-samples.mjs ./scripts/og-script-samples.mjs
RUN node scripts/check-og-runtime.mjs

# ORIGIN is intentionally absent: Kubernetes supplies HOST_HEADER and
# PROTOCOL_HEADER so adapter-node derives the public origin per namespace.
# Local containers should set ORIGIN explicitly when they are not behind that
# proxy.
ENV PORT=3000

EXPOSE 3000

CMD ["node", "build"]

LABEL org.opencontainers.image.source="https://github.com/free2z/zuu" org.opencontainers.image.revision=$PUBLIC_BUILD_SHA
