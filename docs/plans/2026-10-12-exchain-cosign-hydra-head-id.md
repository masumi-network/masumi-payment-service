# Exchain co-sign: `context.hydraHeadId` for spends inside a Hydra head

Audience: Exchain co-signer team (Yuval). Status: draft for review. Date: 2026-10-12.

Provenance tags: VERIFIED = read in this repo or run in this session. INFERRED = reasoned, not confirmed.

## Summary

The payment node can now pay from a guarded smart wallet while the wallet sits inside an open Hydra head. For these spends, the co-sign request carries one new optional field, `context.hydraHeadId`. When it is set, the wallet input does not exist on L1. The co-signer must read it from that head's snapshot. Everything else in the request is unchanged.

## The change

1. New optional field `context.hydraHeadId`: the on-chain Hydra head id, 56 lowercase hex characters (28 bytes). VERIFIED: `packages/payment-source-v2/src/smart-wallet/cosign-client.ts` (`cosignContextSchema`, regex `^[0-9a-f]{56}$`).
2. The node sends it only for in-head locks. VERIFIED: `l2-guarded-lock-execute.ts` sets `hydraHeadId: head.headIdentifier` in `requestCosign`. The L1 batch path (`execute-guarded-batch.ts`) does not send it.
3. An in-head request always has exactly one intent. VERIFIED: `executeGuardedL2Lock` builds one purchase per body.

## What the co-signer must do

1. Accept `context.hydraHeadId`. A strict schema that rejects unknown context keys refuses every in-head purchase.
2. When the field is set, resolve `walletUtxoRef` in that head's snapshot, not on L1. The wallet output there has the same script address, datum and state token as on L1.
3. Apply the same policy checks: per-transaction cap, period limit, counterparty and asset rules, and the datum's `spentInPeriod`. The validator is the same script in the head and on L1. INFERRED: no policy rule needs to change.
4. Return witnesses in the same response shape (contract 1.1). VERIFIED: the node merges them with `mergeCosignWitnesses` exactly as for L1.

## What does not change

- Request fields `batchId`, `walletUtxoRef`, `intents`, `txBodyHex`, and the other context fields (`nodeId`, `orgId`, `submittedAt`, `walletAddress`).
- Response shape, verdicts and the partial-approval rules.
- L1 batches: they never carry `hydraHeadId`.

## How it was tested

- VERIFIED on preprod with hydra-node 2.4.1, against a local mock co-signer (`packages/payment-source-v2/scripts/smart-wallet-hydra/mock.mts`). The mock resolves `walletUtxoRef` from the head node's `/snapshot/utxo`.
- Result: a 10 ADA purchase inside the head was co-signed and locked (FundsLocked, tx `3aa8f216…`). A 25 ADA purchase was refused by the per-transaction cap (20 ADA), and no transaction was built.
- Not tested: the real Exchain co-signer.

## Open questions for Exchain

1. How does Exchain read a head snapshot? It needs an endpoint of a node in that head, or the payment node must send the wallet output in the request. A node endpoint can be private. INFERRED: sending the resolved output would need a further contract change.
2. Validity interval: an in-head transaction uses slots from the head's clock, not from L1. INFERRED: if Exchain checks the validity window against L1 time, it needs a rule for in-head bodies.
3. Rolling windows: in-head spends move the wallet's `spentInPeriod` in the head. Should Exchain count them in the same window as L1 spends? INFERRED: yes, because the datum carries one counter.

## Least confident decisions

1. Using the on-chain head id as the key. A node-local head id would be easier for us to send but means nothing to Exchain.
2. The field is optional and has no version bump. A co-signer that ignores unknown fields would then fail to find the wallet on L1. It would not sign the wrong thing.
3. The assumption that Exchain can reach a head node to read the snapshot.
