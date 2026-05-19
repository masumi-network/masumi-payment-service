# 0002: Single V2 Registry Source Per Network

## Status

Accepted

## Context

The V2 registry policy is stateless/shared. Without an extra service-side rule, multiple active V2 sources on the same network would make `agentIdentifier` inference ambiguous for shared routes.

## Decision

Support one active `Web3CardanoV2` payment source per network.

## Consequences

Agent-identifier lookup and source inference stay deterministic. Admin payment-source creation must reject a second active V2 source for the same network until the existing one is disabled or soft deleted.
