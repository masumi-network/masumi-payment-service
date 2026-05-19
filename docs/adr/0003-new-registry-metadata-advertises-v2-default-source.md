# 0003: New Registry Metadata Advertises V2 Default Source

## Status

Accepted

## Context

V2 registry metadata needs to advertise which payment source an agent supports. Existing on-chain metadata should remain valid and unchanged.

## Decision

Regular registry metadata version 2 includes `supported_payment_sources`. New registry entries default to the configured V2 default supported source when callers omit an override. Existing metadata is not rewritten. Inbox registry metadata remains on its current shape.

## Consequences

New agents can advertise V2 payment support without a breaking route change. Old registry assets remain parseable as metadata version 1. The service must validate supported payment sources with chain/network-specific rules before persisting JSON or minting metadata.
