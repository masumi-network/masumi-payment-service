FROM node:20-slim AS backend-builder
RUN apt-get update -y && apt-get install -y openssl
RUN npm install -g pnpm
# Build backend step
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY smart-contracts ./smart-contracts
COPY ./packages ./packages
COPY ./src ./src
COPY ./prisma ./prisma
COPY ./public ./public
COPY tsconfig.json .
COPY eslint.config.mjs .
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile
# pkgroll bundles both Mesh SDK lines, two @cardano-sdk/core versions, and the
# x402 packages' viem/@x402 graphs (per-importer bundling is intentional — see
# docs/adr/0005), which exceeds Node's default ~2GB heap on CI builders.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build
RUN pnpm run swagger-json

#RUN pnpm run prisma:migrate

# Frontend build step
FROM node:20-slim AS frontend-builder
RUN npm install -g pnpm
WORKDIR /usr/src/app
COPY package.json pnpm-workspace.yaml ./
COPY patches ./patches
COPY ./packages ./packages
COPY --from=backend-builder /usr/src/app/pnpm-lock.yaml ./
WORKDIR /usr/src/app/frontend
ARG NEXT_PUBLIC_PAYMENT_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_PAYMENT_API_BASE_URL=${NEXT_PUBLIC_PAYMENT_API_BASE_URL}
COPY frontend/package.json ./
COPY frontend/openapi-ts.config.ts ./openapi-ts.config.ts
# `openapi-ts` runs a post-generation patch script from here. Without this the
# stage fails with ERR_MODULE_NOT_FOUND on the script path.
COPY frontend/scripts ./scripts
COPY frontend/src ./src
COPY frontend/public ./public
COPY frontend/next.config.ts ./
COPY frontend/postcss.config.mjs ./
COPY frontend/tsconfig.json ./
COPY frontend/components.json ./
COPY --from=backend-builder /usr/src/app/src/utils/generator/swagger-generator/openapi-docs.json ./openapi-docs.json

RUN pnpm install --frozen-lockfile
RUN pnpm run openapi-ts
RUN pnpm run build


# Final stage
FROM node:20-slim AS runner
RUN apt-get update -y && apt-get install -y openssl
RUN npm install -g pnpm
WORKDIR /usr/src/app

# Copy backend files
COPY --from=backend-builder /usr/src/app/dist ./dist
COPY --from=backend-builder /usr/src/app/node_modules ./node_modules
COPY --from=backend-builder /usr/src/app/package.json ./
COPY --from=backend-builder /usr/src/app/prisma ./prisma
COPY --from=backend-builder /usr/src/app/smart-contracts ./smart-contracts
COPY --from=backend-builder /usr/src/app/src ./src
COPY --from=backend-builder /usr/src/app/public ./public
COPY --from=backend-builder /usr/src/app/tsconfig.json ./tsconfig.json
COPY --from=backend-builder /usr/src/app/eslint.config.mjs ./eslint.config.mjs

# Copy frontend files
COPY --from=frontend-builder /usr/src/app/frontend/dist ./frontend/dist

# The project release this image is built from, shown in the admin UI next to
# the latest release. `.git` is not in the build context, so the build passes
# them in:
#   --build-arg MASUMI_RELEASE_VERSION="$(git describe --tags --long --match '[0-9]*.[0-9]*.[0-9]*')"
#   --build-arg MASUMI_RELEASE_COMMIT="$(git rev-parse HEAD)"
ARG MASUMI_RELEASE_VERSION=
ARG MASUMI_RELEASE_COMMIT=

EXPOSE 3001
ENV NODE_ENV=production \
	MASUMI_RELEASE_VERSION=${MASUMI_RELEASE_VERSION} \
	MASUMI_RELEASE_COMMIT=${MASUMI_RELEASE_COMMIT}
CMD [ "pnpm", "run", "start" ]
