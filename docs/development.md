# Developing

## Architecture

The Masumi Payment Service is built using a hexagonal architecture pattern, separating core business logic from external interfaces and infrastructure concerns.

### Technology Stack

#### Core Technologies

- [**OpenAPI**](https://www.openapis.org/): API specification
- [**Express-Zod-Api**](https://www.npmjs.com/package/express-zod-api): REST API framework with built-in validation and Swagger UI
- [**Prisma**](https://www.prisma.io/): Type-safe ORM for PostgreSQL database interactions
- [**Blockfrost**](https://www.blockfrost.io/): Cardano blockchain interaction layer
- [**MeshSDK**](https://www.npmjs.com/package/meshsdk): Cardano wallet and transaction management

#### Development Tools

- [**TypeScript**](https://www.typescriptlang.org/): Primary programming language
- [**Jest**](https://jestjs.io/): Testing framework
- [**ESLint/Prettier**](https://eslint.org/): Code style and formatting
- [**Docker**](https://www.docker.com/): Containerization

### Code Formatting

The project uses Prettier for consistent formatting across both backend and frontend:

```bash
# Format all files
pnpm run format

# Check formatting without writing (useful for CI)
pnpm run format:check
```

#### Formatting Rules

| Rule            | Value    |
| --------------- | -------- |
| Indent          | 2 spaces |
| Quotes          | Single   |
| Semicolons      | Always   |
| Trailing Commas | All      |
| Line Width      | 100      |
| End of Line     | LF       |

The `.editorconfig` file at the project root ensures your editor applies these settings automatically.

#### Infrastructure

- [**PostgreSQL**](https://www.postgresql.org/): Primary database
- [**Blockfrost API**](https://docs.blockfrost.io/): Blockchain data provider to interact with the Cardano Nodes

### Project Structure

- [**src/routes/\*\***](../src/routes/): API routes and validation
- [**src/services/\*\***](../src/services/): Business logic and core functionality
- [**src/utils/\*\***](../src/utils/): Helper functions and utilities
- [**src/middleware/auth-middleware/\*\***](../src/middleware/auth-middleware/): Authentication middleware
- [**src/config/\*\***](../src/config/): Configuration settings

- [**prisma/\*\***](../prisma/): Database generation and ORM related files

## API documentation (OpenAPI)

Endpoint documentation is registered against the zod schemas the routes
themselves use. Docs for a route area live next to the routes in
`src/routes/api/<area>/docs.ts` (e.g. `monitoring`, `registry-inbox`, `x402`);
older multi-area registrars still live in
`src/utils/generator/swagger-generator/registrars/` and are being migrated
area by area — put NEW endpoint docs in the route area's `docs.ts`.

When you add or change an endpoint: update the area's docs in the same PR and
run `pnpm run swagger-json`. CI fails if `openapi-docs.json` is out of sync
with the code.

## API Pagination

List endpoints that accept `cursorId` intentionally use inclusive cursor semantics. When a request includes a cursor,
the response may include the cursor row again. This keeps pagination and polling callers idempotent across retries and
concurrent updates. Clients should de-duplicate by `id` when appending pages or use the last returned `id` as the next
cursor according to the endpoint contract.

Do not add Prisma `skip: 1` to these list queries unless the API contract is intentionally changed and downstream
clients are updated.

## Testing

This project uses Jest as the testing framework. Here's how you can run tests:

- Run `pnpm run test` to execute all tests.
- Run `pnpm run test:watch` to run tests in watch mode, which will re-run tests on file changes.
- Run `pnpm run test:coverage` to see the test coverage report.

> **Always run tests through the pnpm scripts, never bare `npx jest`.** The
> scripts set `NODE_OPTIONS="--experimental-vm-modules --require ./jest.preload.cjs"`,
> which Jest needs for this ESM codebase. Bare `jest` fails with misleading
> errors about `import.meta`, top-level `await`, or `express-zod-api` imports —
> those are NOT real test failures.

End-to-end tests (real Preprod blockchain, separate database) are documented in
[e2e-testing.md](e2e-testing.md).

### Writing Tests

Tests are located in the `src` directory, alongside the files they are testing. Test files should follow the naming
convention of `*.spec.ts` or `*.test.ts`.

## Tools

### Visual Studio Code

To make your life easier, we can strongly recommend the following extensions

- Installing the [Eslint](https://marketplace.cursorapi.com/items?itemName=dbaeumer.vscode-eslint) and [Prettier -
  Code formatter](https://marketplace.cursorapi.com/items?itemName=esbenp.prettier-vscode) extensions is recommended.
  This ensures you can follow the formatting standard used.
- Install the [Prisma](https://marketplace.cursorapi.com/items?itemName=Prisma.prisma) extension if you plan to
  modify the database schema.
- In case you want to work with the smart contracts we recommend [Aiken](https://marketplace.cursorapi.com/items?
  itemName=TxPipe.aiken)
