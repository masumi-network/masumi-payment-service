# Security Guidelines

## Overview

The Masumi Payment Service handles financial transactions and requires secure wallet management. This guide outlines critical security considerations and best practices.

## Wallet Management

### Required Wallet Types

1. **Transaction Wallet**
   - Purpose: Handles incoming payments
   - Requirements:
     - Maintain sufficient funds for smart contract interactions
     - Automatically receives small fee from payouts for liquidity
   - Note: Can be split into multiple wallets for parallel processing

2. **Collection Wallet**
   - Purpose: Stores accumulated funds
   - Requirements:
     - Should be a cold storage wallet
     - Credentials should NOT be available to this service
     - Preferably managed through hardware wallet

3. **Purchase Wallet**
   - Purpose: Handles outgoing payments
   - Requirements:
     - Maintain sufficient funds for purchases
     - Additional ADA for transaction fees
     - Regular monitoring of balance
     - Only fund it as much as you expect to spend
     - Credentials are encrypted and stored in the database

## Security Best Practices

### Service Security

1. **Network Security**
   - Never expose service to public networks
   - Use secure VPN or private network access
   - Implement strict firewall rules

2. **Access Control**
   - Implement minimal role-based access control
   - Use strong API key authentication
   - Regular audit of access patterns
   - Ensure API key confidentiality

3. **Data Protection**
   - Encrypt sensitive data at rest
   - Secure key management
   - Regular backup procedures
   - Inject backend secrets at runtime instead of baking `.env` files into Docker images
   - Treat all `NEXT_PUBLIC_*` values as public client-side configuration, never as secrets

4. **Container and Frontend Secrets**
   - Use `docker run --env-file .env ...` or Compose `env_file` for backend runtime secrets
   - Keep `.env` and `frontend/.env` out of the Docker build context
   - Pass only explicit public build arguments to the frontend image build
   - Never place real wallet mnemonics, admin credentials, or provider secrets in `NEXT_PUBLIC_*` variables

### Maintenance

1. **Updates**
   - Deploy regular security patches
   - Version control monitoring
   - Dependency updates

2. **Monitoring**
   - Transaction monitoring
   - Wallet balance alerts
   - Error rate tracking

## Auditing

- Smart contracts are audited by [TxPipe](https://txpipe.io/) please check the [audit report](audit.pdf)
- The payment service is not yet audited by a third Party. Do check the codebase before exposing it publicly

We follow security best practices, however this is in a MVP state. Any use is at your own discretion.
