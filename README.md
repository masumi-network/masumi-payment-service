# Masumi Payment Service

The Masumi Payment Service provides an easy-to-use service to handle decentralized payments for AI agents. It supports a RESTful API and includes functionalities such as wallet generation, payment verification, and automated transaction handling.

[![CodeFactor](https://www.codefactor.io/repository/github/masumi-network/masumi-payment-service/badge/main)](https://www.codefactor.io/repository/github/masumi-network/masumi-payment-service/overview/main)

## Introduction

Masumi is a decentralized protocol designed to enable AI agents to collaborate and monetize their services efficiently. If you are developing an agentic service using frameworks like CrewAI, AutoGen, PhiData, LangGraph, or others, Masumi is built for you.

### Key Features:

- **Identity Management**: Establish trust and transparency by assigning an identity to your AI service.
- **Decision Logging**: Securely log agent outputs on the blockchain to ensure accountability.
- **Payments**: Facilitate agent-to-agent transactions and revenue generation.

Learn more about Masumi in our [Introduction Guide](https://docs.masumi.network/get-started/introduction).

## Hydra Layer 2 (L2)

When a [Hydra Head](https://hydra.family/head-protocol/) is active between two agents, the service routes transactions to the Hydra node instead of Cardano L1:

- **L1**: ~20s confirmation, ~0.3 ADA per tx
- **L2**: ~1s confirmation, 0 ADA fees

**Lifecycle**: Open head → Transact on L2 → Close head (settle to L1)

Set `HYDRA_ENABLED=true` and configure `HYDRA_NODE_URL` to enable. See [Hydra L2 Architecture](docs/hydra-l2-architecture.md) for details.

## Documentation

We have been successfully audited by [TxPipe](https://txpipe.io/) please check the [full report](docs/audit.pdf)

Refer to the official [Masumi Docs Website](https://docs.masumi.network) for comprehensive documentation and full setup guide.

Additional guides can be found in the [docs](docs/) folder:

- [Configuration Guide](docs/configuration.md)
- [Security Guidelines](docs/security.md)
- [Hydra L2 Architecture](docs/hydra-l2-architecture.md)
- [Transaction Router (L1/L2 Routing)](docs/transaction-router.md)
- [Development and Architecture Guide](docs/development.md)
- [Deployment Guide](docs/deployment.md)
- [Monitoring Guide](docs/monitoring.md)

## Audit

The Masumi Payment Service Smart Contracts have been audited by [TxPipe](https://txpipe.io/).
Audit available [here](audits/Masumi-Payment-Service-Audit-April-2025.pdf)

## Contributing

We welcome contributions! Refer to our [Contributing Guide](CONTRIBUTING.md) for more details.

## License

This project is licensed under the MIT License.
