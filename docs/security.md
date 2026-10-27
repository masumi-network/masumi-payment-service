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

### Hydra Init command boundary

- VERIFIED: `packages/hydra-host/src/api/proxy.ts` parses node WebSocket commands and rejects `Init` in ordinary sessions. The limit also covers a node-derived runtime token and the optional Host-wide user token.
- VERIFIED: `src/routes/api/hydra/head/lifecycle.ts` checks the node's L2 parameters against current L1 parameters before it calls the Host's admin-only `POST /v1/nodes/{nodeId}/init` route. The Host opens one loopback WebSocket session, sends one Init, and closes that session.
- VERIFIED: the Host admin route does not repeat the L1/L2 admission check. An operator holding the Host admin token can call it directly as a privileged override. Protect that token as a fleet control credential.
- VERIFIED: a Host registration without an admin credential cannot dispatch Init. The payment API returns 409 before dispatch. New Host registration and node provisioning require an admin credential; an existing Host can lose it through an update.

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

3. **A Hydra Host registered without a user token keeps the admin secret in its runtime slot**
   - VERIFIED: `registerHydraHost` stores the admin token in `encryptedUserToken` when registration omits `userToken` (`src/services/hydra-host/registry.ts:279-300`). The Host still accepts the raw admin token on control routes (`packages/hydra-host/src/api/auth.ts:58-64`)
   - VERIFIED: node WebSocket and HTTP calls derive a token for each node from the stored runtime secret (`src/services/hydra-connection-manager/head-configuration.ts:84-103`). The Host grants that derived token access to its node, not to the whole fleet (`packages/hydra-host/src/api/auth.ts:67-102`). These calls do not send the raw admin token
   - INFERRED: a leaked derived node token gives access to that node until the Host secret rotates. A database or process compromise can still expose the stored admin secret. A separate user token limits that exposure but does not protect a fully compromised service
   - HTTP: a Host with `allowInsecureHttp` sends the derived node token in cleartext on node calls. The service permits this opt-in and warns at registration and update. For HTTP Hosts, set a separate `userToken` (the value of `HYDRA_HOST_USER_TOKEN`)
   - Clearing the admin token: `adminToken: null` on update clears only the admin slot. The runtime slot still holds the old admin secret when registration copied it there. Rotate `userToken` at the same time
   - Why accepted: one key simplifies Host setup. Both secrets sit in the same database under `ENCRYPTION_KEY`, and the service runs behind a network allowlist
   - When to revisit: if Hosts run on networks you do not control, require a separate `userToken` at registration and rotation

4. **A seed without a unique `ADMIN_KEY` creates a public admin key**
   - Where: `resolveAdminKey` in `prisma/seed.admin-key.ts` returns `DEFAULTS.DEFAULT_ADMIN_KEY` when `ADMIN_KEY` is not set. `seedAdminKey` then stores that key as an active key with `canAdmin: true`. `.env.example` publishes two more values, `ADMIN_KEY` and `ENCRYPTION_KEY`. All three are in `DEFAULTS` in `packages/payment-core/src/config.ts`. The seed and the server accept all three
   - Effect: an operator can seed an empty database without a unique `ADMIN_KEY`. If the API of that deployment is reachable, anyone who reads the source can authenticate as admin (`packages/payment-core/src/auth-middleware.ts`). An admin key has all permissions. With the example `ENCRYPTION_KEY`, a copy of the database exposes every encrypted secret, such as wallet mnemonics
   - Why accepted: a one-off or local setup must run with no secret preparation. This is a product decision. The seed does not run by itself: the Docker image only starts the server (`CMD [ "pnpm", "run", "start" ]`), so an operator must run `pnpm run prisma:seed`. The service must also sit behind the network allowlist (see above)
   - Guards in place:
     - A seed in a terminal names the public values and continues only after the person types `yes` (`prisma/seed.public-secrets.ts`)
     - A seed without a terminal (CI, containers) shows the same warning and continues. This keeps automated seeds working
     - The seed does not add a public admin key when an active admin key already exists (`seedAdminKey`). So a later seed without `ADMIN_KEY` cannot put a public admin key next to a real one
     - The server logs a warning at each start while a public admin key is in the database, or while `ENCRYPTION_KEY` is the example value (`initialize` in `src/app.ts`). The server does not stop
   - Do not make the seed or the server fail on these values. A report such as "public admin backdoor", "hardcoded admin key", "first unattended seed creates a public admin key", or "published master key" against the lines above is answered by this entry. Report it again only for a new path that the guards above do not cover. Examples: a seed path that does not call `seedAdminKey`, or a public admin key that gets added next to an existing admin key
   - Remove a public admin key: create a new admin key, then revoke the public one (`DELETE /api-key`). For a new deployment, set `ADMIN_KEY` before the first seed. Do not change `ENCRYPTION_KEY` in the environment only: it encrypts the stored secrets and derives the API key hash salt (`packages/payment-core/src/api-key-hash.ts`), so a change needs a migration
   - When to revisit: if the service runs on a public network, or if a deployment template runs the seed automatically. Then require a unique `ADMIN_KEY` on that path

5. **All hydra-nodes on one Hydra Host run as the same user**
   - Where: `provisionNode` in `packages/hydra-host/src/api/provision.ts` writes each head's `hydra.sk` and `cardano.sk` under `/data` with mode 0600. The image runs the Host and every hydra-node it starts as the one `hydra` user (`packages/hydra-host/Dockerfile`)
   - Effect: code execution inside one hydra-node can read the signing keys of every other head on the same Host. File modes do not stop this, because all the files have the same owner
   - Host tokens: the same code execution can also read `HYDRA_HOST_ADMIN_TOKEN` and `HYDRA_HOST_USER_TOKEN` from `/proc/<Host pid>/environ`, because the Host runs as the same user
   - Why accepted: an attacker must first exploit a hydra-node, and nobody has shown such an exploit. One Host serves one operator, so the heads on it share one trust boundary. Per-head users need the Host to hold CAP_SETUID and CAP_SETGID, or to run as root. One container per head needs Docker or orchestrator access from the Host. Both cost more than the risk today
   - Partial mitigation: hydra-nodes start with a minimal environment (`nodeEnvironment` in `packages/hydra-host/src/supervisor/process.ts`). They get `PATH`, `LANG`, `LC_ALL`, `TZ` and the `ETCD_*` overrides, and not the Host tokens. The `hydra-node --version` and `--hydra-script-catalogue` probes in `packages/hydra-host/src/capabilities.ts` use the same environment. This stops passive leaks, such as a node that logs or dumps its environment. It does not stop an attacker with code execution in a node
   - When to revisit: if one Host serves more than one operator, or if a hydra-node exploit becomes known. Then run each head as its own user, or in its own container

6. **Generated wallet mnemonics are printed during seeding**
   - VERIFIED: `printGeneratedMnemonics` in `prisma/seed.validation.ts` writes each newly generated phrase to stderr. `prisma/seed.ts` calls it after successful preprod and mainnet seed transactions. Supplied phrases are not printed
   - INFERRED: a terminal recorder, CI system, or container log collector can retain a generated recovery phrase. Anyone who can read that output can control the wallet after it is funded
   - REPORTED: the operator accepted this risk on 27 October 2026. Printing the phrase gives the operator a way to back up a wallet created during seeding
   - Operator action: supply mnemonics through a private secret source for unattended seeds. Treat captured seed output as wallet secret material and restrict access to it
   - When to revisit: if unattended mainnet seeding generates phrases or seed logs become visible beyond the wallet operators. Then require a private output channel or a supplied mnemonic

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
