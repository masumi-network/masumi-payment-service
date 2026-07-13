# Masumi Payment Service

The Masumi Payment Service provides an easy-to-use service to handle decentralized payments for AI agents. It supports a RESTful API and includes functionalities such as wallet generation, payment verification, and automated transaction handling, with batched on-chain settlement for registration and payment actions.

[![CodeFactor](https://www.codefactor.io/repository/github/masumi-network/masumi-payment-service/badge/main)](https://www.codefactor.io/repository/github/masumi-network/masumi-payment-service/overview/main)

## Introduction

Masumi is a decentralized protocol designed to enable AI agents to collaborate and monetize their services efficiently. If you are developing an agentic service using frameworks like CrewAI, AutoGen, PhiData, LangGraph, or others, Masumi is built for you.

### Key Features:

- **Smart Contract Escrow**: Lock funds on-chain with Aiken smart contracts, supporting result submission, dispute resolution, and automatic release after cooldown periods.
- **Agent Registry**: Register and manage AI agent identities on the Cardano blockchain with on-chain metadata and pricing configuration.
- **Wallet Management**: Create and manage hot wallets for buying and selling, with encrypted secret storage, UTXO tracking, and multi-network support (Preprod & Mainnet).
- **Low-Balance Alerts**: Configure per-wallet threshold rules to monitor asset balances and receive webhook notifications when funds drop below defined levels.
- **Refund & Dispute Handling**: Full refund lifecycle with buyer-initiated requests, seller authorization, admin dispute resolution, and automatic timeout-based approvals.
- **Token Swaps**: Swap between on-chain assets with cost estimation, status tracking, and cancellation support.
- **Webhook Notifications**: Subscribe to payment, purchase, and wallet events with automatic retry, exponential backoff, and delivery tracking.
- **Invoice Generation**: Generate monthly invoices with VAT/reverse-charge support and PDF export.
- **Observability**: Built-in OpenTelemetry integration for distributed tracing, metrics, and structured log export to SigNoz, Grafana, or Datadog.
- **Admin Dashboard**: Next.js frontend for managing agents, wallets, API keys, and monitoring wallet health.

Learn more about Masumi in our [Introduction Guide](https://www.masumi.network/dev/masumi/documentation).

## Getting Started

Prerequisites: Node.js ≥ 20, [pnpm](https://pnpm.io), and a PostgreSQL database.

```bash
git clone https://github.com/masumi-network/masumi-payment-service.git
cd masumi-payment-service
pnpm install                    # installs deps + generates the Prisma client

cp .env.example .env            # then fill in DATABASE_URL, ENCRYPTION_KEY,
                                # Blockfrost keys, ... (see docs/configuration.md)

pnpm run prisma:migrate:dev     # apply database migrations
pnpm run prisma:seed            # seed initial data (admin key, payment source)

pnpm run dev                    # start the API server
```

The admin dashboard is a separate Next.js app with its own install:

```bash
cd frontend
pnpm install
pnpm run dev
```

Useful commands: `pnpm run test` (unit tests — always via pnpm, not bare
`npx jest`), `pnpm run lint`, `pnpm run format`, `pnpm run typecheck`. See the
[Development Guide](docs/development.md) for architecture and testing details
and [docs/e2e-testing.md](docs/e2e-testing.md) for end-to-end tests.

## Documentation

We have been audited by [TxPipe](https://txpipe.io/) please check the [full report](docs/audit.pdf) for details.

Refer to the official [Masumi Docs Website](https://www.masumi.network/dev/masumi) for comprehensive documentation and full setup guide.

Additional guides can be found in the [docs](docs/) folder:

- [Configuration Guide](docs/configuration.md)
- [Security Guidelines](docs/security.md)

- [Development and Architecture Guide](docs/development.md)
- [Deployment Guide](docs/deployment.md)
- [Monitoring Guide](docs/monitoring.md)
- [x402 EVM Payment Rail Guide](docs/x402.md)

## Audit

The Masumi Payment Service Smart Contracts have been audited by [TxPipe](https://txpipe.io/).
Audit available [here](audits/Masumi-Payment-Service-Audit-April-2025.pdf)

## Contributing

We welcome contributions! Refer to our [Contributing Guide](CONTRIBUTING.md) for more details.

## License

This project is licensed under the MIT License.
