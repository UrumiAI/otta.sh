# The Otta storefront + admin as a container — DEPLOYMENT.md §3bis.
#
# This is the build contract for a hosting platform's "Deploy from GitHub": a
# Dockerfile at the repo root producing an image that serves on PORT (4321) and
# takes its configuration entirely from the environment. The commerce service
# is a SEPARATE image (Dockerfile.service) with a SEPARATE database; deploy it
# first, because its URL is baked into this build.
#
#   docker build \
#     --build-arg COMMERCE_SERVICE_URL=https://commerce.example.com \
#     -t otta-store .
FROM node:22-slim AS base
# pnpm via npm rather than corepack: corepack resolves and verifies the package
# manager over the network on first invocation, which makes every build stage a
# separate network failure point.
RUN npm install -g pnpm@11.10.0
WORKDIR /app

# Every package.json in the workspace, and nothing else. pnpm resolves the
# lockfile against the WHOLE workspace even when the install is filtered to one
# package, so the runtime stage needs all of them — collected rather than
# enumerated so a package added later cannot silently break this image.
FROM base AS manifests
COPY . .
RUN find . -name node_modules -prune -o -name package.json -print \
	| xargs -I{} install -D {} /manifests/{}

FROM base AS build
COPY . .
# --ignore-scripts skips better-sqlite3's native compile (emdash depends on it
# for its sqlite dialect, which this target never selects — the content
# database is Postgres) so the image needs no C++ toolchain. Everything else
# that matters here ships prebuilt platform binaries as ordinary optional
# dependencies: esbuild's and sharp's postinstalls only validate them.
RUN pnpm install --frozen-lockfile --ignore-scripts

# BUILD-TIME contract, both of them (DEPLOYMENT.md §1):
#  - COMMERCE_SERVICE_URL is baked into the plugin bundle AND the descriptor's
#    allowedHosts egress gate. Changing it means rebuild + redeploy; a build
#    without it produces a deployable-but-inert commerce egress.
#  - OTTA_SITE_TARGET=node selects the Node adapter, Postgres and S3.
ARG COMMERCE_SERVICE_URL
ARG STRIPE_PUBLIC_KEY
ENV COMMERCE_SERVICE_URL=${COMMERCE_SERVICE_URL}
ENV STRIPE_PUBLIC_KEY=${STRIPE_PUBLIC_KEY}
ENV OTTA_SITE_TARGET=node
RUN pnpm --filter @otta-sh/site-staging build:node

FROM base AS runtime
ENV NODE_ENV=production

# A fresh production-only install rather than a copy of the build stage's
# node_modules: pnpm's store is a symlink farm, and copying it across stages
# carries links that resolve to paths the runtime stage does not have. The
# workspace manifests are all required — pnpm resolves the lockfile against
# the whole workspace even when filtering to one package.
COPY --from=manifests /manifests/ ./
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --prod \
	--filter @otta-sh/site-staging...

COPY --from=build /app/sites/staging/dist ./sites/staging/dist
COPY --from=build /app/sites/staging/server ./sites/staging/server

WORKDIR /app/sites/staging

# Run unprivileged. A chart that pins runAsUser 1000 gets the `node` user in
# this base image; a mismatch would make the filesystem unreadable.
RUN chown -R node:node /app
USER node

# HOST must bind all interfaces: the kubelet's probes connect to the pod IP, so
# a loopback-only bind fails liveness and the container is killed.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

# Required at RUNTIME: DATABASE_URL (per-store Postgres — translated to PG* by
# server/cluster.mjs), EMDASH_ENCRYPTION_KEY (the site's one secret),
# EMDASH_SITE_URL (canonical URL; the WebAuthn relying-party id, so the setup
# wizard's passkey step needs it correct AND served over HTTPS).
# Optional: S3_BUCKET / S3_REGION / S3_ENDPOINT for the media library
# (credentials come from the AWS provider chain — IRSA on EKS, never baked),
# WEB_CONCURRENCY, NODE_OPTIONS.
CMD ["node", "./server/cluster.mjs"]
