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

Prerequisites: Node.js ≥ 20, [pnpm](https://pnpm.io), and a PostgreSQL ≥ 13 database (the x402 migrations use the built-in `gen_random_uuid()`).

```bash
git clone https://github.com/masumi-network/masumi-payment-service.git
cd masumi-payment-service
pnpm install                    # installs deps + generates the Prisma client

cp .env.example .env            # then fill in DATABASE_URL, ENCRYPTION_KEY,
                                # Blockfrost keys, ... (see docs/configuration.md)

pnpm run prisma:migrate:dev     # apply database migrations
pnpm run prisma:seed            # seed initial data (admin key, payment source)

pnpm run dev                    # start the API server on http://localhost:3001
```

Once the API server is up, open **<http://localhost:3001/>** — browser requests
to `/` are redirected to the admin interface at `/admin/`. API clients, health
probes and `curl` are unaffected: the redirect only fires for requests that
actually ask for HTML.

The admin interface served under `/admin/` is the **built** Next.js bundle
(`frontend/dist`), so it only exists after the frontend has been built. To work
on the dashboard itself, run it as its own dev server instead — that gives you
hot reload on <http://localhost:3000/>:

```bash
cd frontend
pnpm install
pnpm run dev                    # http://localhost:3000
```

In that mode the frontend needs to be told where the API lives, since the
default `/api/v1` is same-origin and only resolves in production where the
backend serves the built bundle. Point it at the running backend in
`frontend/.env.local`:

```bash
NEXT_PUBLIC_PAYMENT_API_BASE_URL=http://localhost:3001/api/v1
```

The admin interface is designed for desktop. Narrow screens now show a
dismissible warning rather than being blocked outright, but tables and dialogs
are still cramped below ~1024px.

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
