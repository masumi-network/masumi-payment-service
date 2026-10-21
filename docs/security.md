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

5. **Network Allowlist (Required)**
   - Put the payment service behind an IP allowlist, a VPN, or a private network
   - Only your own agents, frontends, and operators must be able to reach the API
   - Add rate limits at the ingress (reverse proxy, load balancer, or firewall)
   - The service does not rate-limit unauthenticated requests by itself. It relies on this allowlist

### Accepted Risks

These behaviours are intended. Reviewers do not need to report them again.

1. **API key checks cost PBKDF2 work before the database lookup**
   - Where: `packages/payment-core/src/auth-middleware.ts` calls `generateApiKeySecureHash`, which runs PBKDF2-SHA512 with 100,000 iterations (`packages/payment-core/src/api-key-hash.ts`)
   - Effect: each request with a token, valid or invalid, costs one hash on the Node.js crypto thread pool. Many invalid requests can fill the pool and delay valid payment and Hydra requests
   - Why accepted: the service must sit behind a network allowlist (see above). An attacker who cannot reach the API cannot send the invalid requests
   - When to revisit: if you expose the service to public networks. Then add ingress rate limits, or replace PBKDF2 with a keyed HMAC. A keyed HMAC gives the same protection here, because the hash salt and the stored `encryptedToken` both depend on `ENCRYPTION_KEY`
   - Scope: this applies to the payment service only. The `hydra-host` package does not use this hash

2. **Pull request CI jobs run branch code with preprod secrets**
   - Where: `.github/workflows/e2e.yml` gives preprod wallet mnemonics and other secrets to the E2E job. `.github/workflows/dev.yml` gives `BLOCKFROST_API_KEY_PREPROD` to a job that runs a PR script. Both trigger on pull requests to `dev` and name no protected Environment
   - Effect: a person who can push a branch to this repository can change a script or an install hook and read those secrets
   - Why accepted: all of these secrets are preprod only. The wallets hold test ADA, and the Blockfrost key reaches preprod only. No mainnet key or production credential is in these jobs. Only internal team members can push branches to this repository. Fork pull requests get no secrets
   - When to revisit: if a job gets a mainnet or production secret, or if people outside the team get write access. Then put the secret-bearing jobs behind a reviewed Environment, or run them only from reviewed code

3. **A Hydra Host registered without a user token runs on its admin token**
   - Where: `registerHydraHost` in `src/services/hydra-host/registry.ts` stores the admin token in `encryptedUserToken` when the request has no `userToken`. The Host accepts the admin token for user operations (`packages/hydra-host/src/api/auth.ts`)
   - Effect: every runtime call (node WebSocket, node HTTP API, health checks) sends the admin token. A leak on the runtime path, such as a proxy log or a memory dump, gives full control of the Host fleet (provision, reconfigure, delete), not only node access
   - Why accepted: it keeps Host setup to one key. Both tokens sit in the same database under the same `ENCRYPTION_KEY`, and the same process reads them. So a split does not protect against a server compromise. It protects only against leaks on the runtime path, and the service runs behind the network allowlist
   - HTTP: a Host with `allowInsecureHttp` sends the admin token in cleartext on every node call. The service does not block this. It logs a warning at registration and on each update of such a Host, also when the user token equals the admin token. The connect dialog shows a warning too. The service cannot see the case after an earlier update cleared the admin slot, so that Host gets no warning. For HTTP Hosts, set a separate `userToken` (the value of `HYDRA_HOST_USER_TOKEN`)
   - Clearing the admin token: `adminToken: null` on update clears only the admin slot. The runtime slot still holds the old admin token. Rotate `userToken` at the same time
   - When to revisit: if Hosts run on networks you do not control. Then make `userToken` required at registration and rotation

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
