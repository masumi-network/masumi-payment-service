FROM node:20-slim AS backend-builder
RUN apt-get update -y && apt-get install -y openssl
RUN npm install -g pnpm
# Build backend step
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY smart-contracts ./smart-contracts
COPY ./src ./src
COPY ./prisma ./prisma
COPY ./public ./public
COPY tsconfig.json .
COPY eslint.config.mjs .
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm run swagger-json

#RUN pnpm run prisma:migrate

# Frontend build step
FROM node:20-slim AS frontend-builder
RUN npm install -g pnpm
WORKDIR /usr/src/app
COPY package.json pnpm-workspace.yaml ./
COPY --from=backend-builder /usr/src/app/pnpm-lock.yaml ./
WORKDIR /usr/src/app/frontend
ARG NEXT_PUBLIC_PAYMENT_API_BASE_URL=/api/v1
ARG NEXT_PUBLIC_BLOCKFROST_API_KEY=""
ARG NEXT_PUBLIC_MAESTRO_API_KEY=""
ARG NEXT_PUBLIC_TRANSAK_API_KEY=""
ARG NEXT_PUBLIC_DEV="false"
ARG NEXT_PUBLIC_DEV_WALLET_ADDRESS=""
ARG NEXT_PUBLIC_DEV_WALLET_MNEMONIC=""
ENV NEXT_PUBLIC_PAYMENT_API_BASE_URL=${NEXT_PUBLIC_PAYMENT_API_BASE_URL}
ENV NEXT_PUBLIC_BLOCKFROST_API_KEY=${NEXT_PUBLIC_BLOCKFROST_API_KEY}
ENV NEXT_PUBLIC_MAESTRO_API_KEY=${NEXT_PUBLIC_MAESTRO_API_KEY}
ENV NEXT_PUBLIC_TRANSAK_API_KEY=${NEXT_PUBLIC_TRANSAK_API_KEY}
ENV NEXT_PUBLIC_DEV=${NEXT_PUBLIC_DEV}
ENV NEXT_PUBLIC_DEV_WALLET_ADDRESS=${NEXT_PUBLIC_DEV_WALLET_ADDRESS}
ENV NEXT_PUBLIC_DEV_WALLET_MNEMONIC=${NEXT_PUBLIC_DEV_WALLET_MNEMONIC}
COPY frontend/package.json ./
COPY frontend/openapi-ts.config.ts ./openapi-ts.config.ts
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

EXPOSE 3001
ENV NODE_ENV=production
CMD [ "pnpm", "run", "start" ]
