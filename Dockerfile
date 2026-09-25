# syntax=docker/dockerfile:1.7
#
# One image for staging (deploy/staging): the built monorepo, which runs as the
# web app (`next start`), the API (the Nitro bundle) and the migration job
# (`tsx apps/api/bin/db.ts migrate`). Build it on an amd64 host: ffmpeg-static
# and @napi-rs/canvas install platform binaries, and `deploy.sh` builds on the
# cluster's own node for that reason.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN yarn install --immutable
RUN yarn build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
# The API, by default; the web container and the migration job set their own command.
CMD ["node", "apps/api/.output/server/index.mjs"]
