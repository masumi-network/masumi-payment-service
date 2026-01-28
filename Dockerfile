FROM node:20-slim AS backend-builder
RUN apt-get update -y && apt-get install -y openssl
RUN npm install -g pnpm
# Build backend step
WORKDIR /usr/src/app
COPY .env* ./

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY smart-contracts ./smart-contracts
COPY ./src ./src
COPY ./prisma ./prisma
COPY ./public ./public
COPY tsconfig.json .
COPY eslint.config.mjs .
COPY certs ./certs
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile
RUN pnpm exec prisma generate
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
COPY frontend/package.json ./
COPY frontend/openapi-ts.config.ts ./openapi-ts.config.ts
COPY frontend/src ./src
COPY frontend/public ./public
COPY frontend/.env* ./
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
COPY --from=backend-builder /usr/src/app/certs ./certs
COPY --from=backend-builder /usr/src/app/tsconfig.json ./tsconfig.json
COPY --from=backend-builder /usr/src/app/eslint.config.mjs ./eslint.config.mjs

# Copy frontend files
COPY --from=frontend-builder /usr/src/app/frontend/dist ./frontend/dist

#optional copy env file
COPY .env* ./


EXPOSE 3001
ENV NODE_ENV=production
CMD [ "pnpm", "run", "start" ]
