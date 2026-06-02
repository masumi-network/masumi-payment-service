# 0003: Registry Metadata Advertises Active Payment Source

## Status

Accepted

## Context

V2 registry metadata needs to advertise which payment source an agent supports. Existing on-chain metadata should remain valid and unchanged.

## Decision

Regular registry metadata version 2 includes `supported_payment_sources` on mint. If callers provide explicit `supportedPaymentSources`, the mint uses those rows. If they omit the field, the mint advertises the active payment source that owns the registration request. The registration API does not persist synthetic default rows; stored rows stay caller-controlled. V2 purchase flows validate the configured payment source via the `smartContractAddress` carried in the `blockchainIdentifier`: the seller's signature is computed over a canonical JSON payload (`buildSignedBlockchainIdentifierPayload`) that includes `smartContractAddress`, and verification reconstructs that payload using the address carried in the identifier — any tampering breaks the signature check. Existing metadata is not rewritten. Inbox registry metadata remains on its current shape.

## Consequences

New agents advertise payment support on-chain without a breaking route change, while API responses continue to distinguish caller-provided rows from minted defaults. Old registry assets remain parseable as metadata version 1. The service must validate caller-provided supported payment sources with chain/network-specific rules before persisting rows or minting metadata.
