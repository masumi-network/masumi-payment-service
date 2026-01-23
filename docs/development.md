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

#### Infrastructure

- [**PostgreSQL**](https://www.postgresql.org/): Primary database
- [**Blockfrost API**](https://docs.blockfrost.io/): Blockchain data provider to interact with the Cardano Nodes

### Project Structure

- [**src/routes/\*\***](../src/routes/): API routes and validation
- [**src/repositories/\*\***](../src/repositories/): Repository pattern for data access
- [**src/services/\*\***](../src/services/): Business logic and core functionality
- [**src/utils/\*\***](../src/utils/): Helper functions and utilities
- [**src/middleware/auth-middleware/\*\***](../src/middleware/auth-middleware/): Authentication middleware
- [**src/config/\*\***](../src/config/): Configuration settings

- [**prisma/\*\***](../prisma/): Database generation and ORM related files

## Testing

This project uses Jest as the testing framework. Here's how you can run tests:

- Run `pnpm run test` to execute all tests.
- Run `pnpm run test:watch` to run tests in watch mode, which will re-run tests on file changes.
- Run `pnpm run test:coverage` to see the test coverage report.

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
