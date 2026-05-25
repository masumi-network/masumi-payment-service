# 0004: Per Payment Source Type Service Trees

## Status

Accepted. Supersedes [0002](0002-single-v2-registry-source-per-network.md).

## Context

The service must run multiple Payment Source Types side by side. Today `Web3CardanoV1` (legacy) and `Web3CardanoV2` (new authorization-aware contract) coexist on the same backend; future Types will add other chains and contract families.

The service resolves some payment-source flows by registry `policyId`, so active `PaymentSource` rows must keep `(network, policyId)` unique. Soft-deleted rows may retain their historical policy id for auditability and rollback, but they do not participate in active source resolution.

The V1 service code base already encodes V1 assumptions deeply: state machine semantics, datum and redeemer shapes, registry policy derivation, refund and withdraw orchestration. Branching V1 vs V2 inline throughout `src/services/payments/`, `src/services/purchases/`, and `src/services/registry/` produced functions whose `V1` suffix did not match their actual behaviour and made code paths hard to follow.

## Decision

1. Keep a single `PaymentSource` table discriminated by an enum column `paymentSourceType`. Future Types extend the enum; the table does not split.
2. Per-Type orchestration code lives in dedicated service trees: `src/services/payment-source-types/web3-cardano-v1/` and `src/services/payment-source-types/web3-cardano-v2/`. Each tree queries only rows whose `paymentSourceType` matches it and owns its own collection, refund, withdrawal, submit-result, and registry flows. Adding a new Type adds a new tree alongside, not new branches inside shared code.
3. Type-agnostic concerns (HTTP routing, validation, queries that span Types, webhook dispatch, hot-wallet management, monitoring) stay in `src/services/` and `src/routes/api/`. Route handlers are thin dispatchers: they resolve the `PaymentSource`, read `paymentSourceType`, and call the matching Type tree.
4. For purchase init, V2 takes `smartContractAddress` as a required input. The seller binds this address into the signed `blockchainIdentifier` payload and into the encoded identifier blob itself, which extends from four dotted segments (V1) to five (V2). The verifier decodes the address from the blob to reconstruct the signed payload exactly, while active `(network, policyId)` uniqueness keeps legacy policy-id lookups deterministic.
5. Supported Payment Sources advertised by a registry entry are persisted as rows in a new `SupportedPaymentSource` child table of `RegistryRequest`, not as JSON and not as a foreign key to `PaymentSource`. Each row carries `chain`, `network`, `paymentSourceType`, and `address`. Empty relation means no payment metadata; this replaces the legacy `PaymentType` enum, which is removed in a follow-up migration after the backfill stabilises.
6. Active `PaymentSource` rows are unique by `@@unique([network, smartContractAddress])` and by a manual partial unique index on `(network, policyId)` where `deletedAt IS NULL` and `policyId IS NOT NULL`. Prisma cannot represent partial unique indexes, so the policy-id invariant lives in SQL migrations and is documented on the model. Multiple sources per network are allowed only when they use distinct smart-contract addresses and distinct active policy ids.
7. Each Type's contract-generator package pins its own `@meshsdk/core` and `@meshsdk/core-cst` versions independently. V1 pins `@meshsdk/core@1.9.0-beta.96` because the deployed V1 contract addresses on Cardano were derived with that release; bumping mesh in V1 can change the bytes emitted by `applyParamsToScript` / `resolvePlutusScriptAddress` and produce a different on-chain address for the same Aiken-compiled validator, which would orphan deployed funds. V2 has no on-chain legacy yet and tracks the latest mesh release. The root workspace and `@/services/shared` use V1's pinned mesh version; when V2 service code accepts a `BlockfrostProvider` or `MeshWallet` from the shared helpers, it imports the type via `@/services/shared` rather than directly from `@meshsdk/core` to avoid duplicate class identity at function boundaries.

## Consequences

Adding a Payment Source Type is a localised change: new enum values, a new service tree, optional new nullable columns on existing tables, no churn in the route layer. The V1 tree stays frozen while V2 evolves; bugs in V1 only touch V1 code.

Route handlers grow slightly: each must resolve a `PaymentSource` and dispatch. The cost is offset by clearer ownership boundaries inside the service layer.

The V2 `blockchainIdentifier` wire format is a deliberate break from V1. SDKs and integrations that produced V2 identifiers against the previous shape must be updated. V1 identifiers remain unchanged.

Reusing a registry `policyId` on the same network requires soft-deleting the previous `PaymentSource` first. This preserves deterministic active lookups while allowing historical rows to remain queryable.

`SupportedPaymentSource` as a child table accepts that the relation is informational. The service does not validate that an advertised source corresponds to a configured `PaymentSource` row on this deployment; an agent may advertise sources the service does not operate. Payment-bearing flows still require a configured source on the deployment's side; this is enforced when resolving for payment-init or purchase-init, not when reading or writing registry metadata.

The `PaymentType` enum on `RegistryRequest` is retired. Until the follow-up migration drops the column, application code reads from the new child table exclusively; the column is left in place only to keep the rollback window open.

Pinning V1 mesh forever is sustainable: V1 is a frozen contract family on chain. New Cardano-on-V2 deployments compile with whatever mesh version V2 tracks, so V2 is always free to upgrade. Future Types (other chains, future Cardano contracts) follow the same pattern — each Type's package owns its own mesh pin policy.
