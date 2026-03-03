# Masumi Payment Service

Cardano blockchain payment escrow service with Aiken smart contracts. Enables secure peer-to-peer payments with dispute resolution for AI agent marketplace.

## Quick Reference

| Action | Command |
|--------|---------|
| Start dev server | `pnpm dev` |
| Run linting | `pnpm run lint` |
| Format code | `pnpm run format` |
| Run tests | `pnpm run test` |
| Run DB migrations | `pnpm run prisma:migrate:dev` |
| Generate Prisma client | `pnpm run prisma:generate` |
| Generate OpenAPI types | `cd frontend && pnpm run openapi-ts-latest` |
| Generate Swagger JSON | `pnpm run swagger-json` |

## Tech Stack

- Backend: Node.js, TypeScript, Express, express-zod-api
- Database: PostgreSQL with Prisma ORM
- Blockchain: Cardano via MeshSDK and Blockfrost API
- Smart Contracts: Aiken language
- Frontend: Next.js, React, TanStack Query, Shadcn UI

## Project Structure

- `src/routes/api/` - API endpoints using express-zod-api
- `src/services/` - Business logic services
- `src/utils/` - Utility functions and helpers
- `src/generated/prisma/` - Prisma client (auto-generated, do not edit)
- `frontend/` - Next.js frontend application
- `frontend/src/lib/api/generated/` - API types (auto-generated, do not edit)
- `smart-contracts/payment/` - Payment escrow smart contract
- `smart-contracts/registry/` - Registry minting contract
- `prisma/` - Database schema and migrations

## Key Principles

- Write clear, technical TypeScript code following established patterns.
- Use functional programming patterns; avoid classes except for services.
- Prioritize readability and maintainability over cleverness.
- Use descriptive variable names with auxiliary verbs (isLoading, hasError).
- Handle errors explicitly with proper status codes and logging.

## Critical Guidelines

- Import Zod from `@/utils/zod-openapi`, never from 'zod' directly.
- Use BigInt for all monetary amounts; never use Number for lovelace values.
- Convert BigInt to string for API responses; JSON cannot serialize BigInt.
- Use `createHttpError()` for HTTP errors, never throw plain Error.
- Use logger from `@/utils/logger`; never use console.log.
- Encrypt wallet secrets using `@/utils/security/encryption` utilities.
- Never edit files in `src/generated/` or `frontend/src/lib/api/generated/`.

## Formatting Standards

- Use single quotes for strings.
- Use 2 spaces for indentation.
- Include trailing commas in multi-line structures.
- End statements with semicolons.
- Prefix unused variables with underscore.
- Run lint and format before committing.

## Commit Standards

- Follow conventional commits: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci
- Keep header under 72 characters
- Use lowercase for type; no period at end

## Payment Contract States

- FundsLocked: Initial state when funds are locked in contract
- ResultSubmitted: Seller has submitted a result hash
- RefundRequested: Buyer has requested a refund
- Disputed: Result submitted but refund is requested

## API Authentication

- Three permission levels: Read, ReadAndPay, Admin
- Use readAuthenticatedEndpointFactory for read operations
- Use payAuthenticatedEndpointFactory for payment operations
- Use adminAuthenticatedEndpointFactory for admin operations

## Dependencies

- express-zod-api for API endpoints with Zod validation
- Prisma for database access via `@/utils/db`
- http-errors for HTTP error handling
- Winston for logging via `@/utils/logger`
- @meshsdk/core for Cardano operations
- @blockfrost/blockfrost-js for blockchain queries
- async-mutex for concurrency control
- advanced-retry for retry logic
- @paralleldrive/cuid2 for ID generation

## Key Files

- Entry point: `src/index.ts`
- Configuration: `src/utils/config/index.ts`
- Database schema: `prisma/schema.prisma`
- Zod extension: `src/utils/zod-openapi.ts`
- Payment contract: `smart-contracts/payment/validators/vested_pay.ak`
- State machine docs: `smart-contracts/payment/state_machine_diagram.md`

## Pre-push Hooks

The following run automatically before push:
- ESLint check on full project
- Swagger JSON generation
- Postman collection update
- Frontend type generation
- Protected branch check (blocks direct push to main/dev)

Refer to documentation in `docs/` for detailed guides on configuration, deployment, and security.
