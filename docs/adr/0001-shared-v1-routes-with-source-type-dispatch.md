# 0001: Shared V1 Routes With Source Type Dispatch

## Status

Accepted

## Context

The public API already exposes `/api/v1` payment, purchase, and registry routes. V2 adds new contract behavior and registry metadata, but clients should not have to move to a new route tree just to select the new payment source.

## Decision

Keep `/api/v1` as the public route namespace. Routes load or infer the configured `PaymentSource`, read its `PaymentSourceType`, and dispatch internally to the registered source adapter for that type.

## Consequences

Existing clients remain compatible with the current route structure. Runtime behavior is selected by configuration and agent registry policy rather than by public URL versioning. Route handlers must keep source-type checks explicit so V1 assumptions do not leak into V2 behavior.
