# Masumi Payment Service Context

## Glossary

### Payment Source Type

The kind of configured payment source. A stable identifier of the chain plus contract family used by one [[Payment Source Module]]. Current values are `Web3CardanoV1` and `Web3CardanoV2`; future Types may target other chains or contract families.

Each Type's contract-generator package pins its own MeshSDK release independently: a Type that has on-chain deployments freezes its mesh version because `applyParamsToScript` / `resolvePlutusScriptAddress` can produce different bytes (and therefore different deployed-contract addresses) across mesh releases. V1 is pinned to `@meshsdk/core@1.9.0-beta.96`; V2 tracks the latest release because it has no on-chain legacy yet.

Avoid: version, protocol.

### Supported Payment Source

A payment option advertised by an agent registry entry, identified by chain, network, [[Payment Source Type]], and address. Persisted as rows in a child table of the registry record, mirroring the on-chain registry metadata. The service does not require a matching configured [[Payment Source]] row to accept or persist a Supported Payment Source — the link is informational, not enforced by foreign key.

The set of Supported Payment Sources on an agent registry record is the single source of truth for "does this registry entry carry payment metadata, and which kinds." An empty set means the entry has no payment metadata (formerly modelled by a separate enum value).

Avoid: payment address.
