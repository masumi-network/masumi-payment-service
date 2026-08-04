# x402 Agent Resource Manifest

An `X402`-type registry entry advertises a single URL — `x402ResourcesUrl` — that
points to a **self-hosted JSON manifest** listing the agent's x402 resources.
This document defines that manifest format.

## Why a manifest (and not on-chain resources)

x402 has **no native concept of an "agent"**. The Coinbase Bazaar is a flat,
facilitator-aggregated catalog of individual priced resources (each keyed by its
own `resource` URL); it never groups resources by provider. So the grouping —
"these N resources belong to one agent" — has to be defined by the registration.
The Masumi registry entry **is** that grouping, and this manifest is its declared
resource set.

Resources are held off-chain in this manifest (not inlined in the on-chain
registry metadata) because an agent may expose hundreds of endpoints, which
Cardano transaction-size limits cannot carry inline. Only the manifest URL lives
on chain; the [registry indexer](https://github.com/masumi-network/masumi-registry-service)
fetches and parses the manifest into a catalog **grouped by agent** — the value
Masumi adds over the flat Bazaar.

## Location

The manifest may be hosted at any HTTPS URL. Agents are **recommended** to use the
emerging community convention `https://<host>/.well-known/x402.json`, but this is
guidance, not a requirement — `x402ResourcesUrl` may point anywhere.

## Format

A JSON object with a top-level `resources` array. Each entry aligns with the x402
Bazaar `DiscoveryResource` shape, **minus per-resource payment fields** — in
Masumi, payment is agent-level and declared via the registry entry's
`supportedPaymentSources` (Cardano or EVM), decoupled from the API access model.

```jsonc
{
  "x402Version": 2,                      // number; x402 protocol version the resources speak
  "resources": [
    {
      "resource": "https://api.example.com/v1/summarize",  // required, absolute URL / MCP identifier
      "type": "http",                    // "http" | "mcp"  (default "http")
      "description": "Summarize a document",               // optional
      "mimeType": "application/json",                       // optional, response media type
      "inputSchema": { "type": "object", "properties": { /* JSON Schema */ } },   // optional
      "outputSchema": { "type": "object", "properties": { /* JSON Schema */ } }   // optional
    }
    // … one entry per priced endpoint
  ]
}
```

### Field notes

| Field | Type | Notes |
| --- | --- | --- |
| `x402Version` | number | The x402 protocol version the resources implement (1 or 2). |
| `resources[].resource` | string (URL) | The callable endpoint (HTTP) or MCP tool identifier. Required. |
| `resources[].type` | `"http"` \| `"mcp"` | Transport. Defaults to `"http"`. Mirrors the Bazaar `type` field. |
| `resources[].description` | string | Human-readable summary. Optional. |
| `resources[].mimeType` | string | Response media type. Optional. |
| `resources[].inputSchema` | JSON Schema | Request/argument schema. Optional. In x402 v2 this corresponds to `extensions.bazaar` `info`/`schema`. |
| `resources[].outputSchema` | JSON Schema | Response schema. Optional. Corresponds to v1's `outputSchema` field / v2 `extensions.bazaar`. |

**No pricing / `accepts` / `payTo` / `asset` fields.** Those belong to the
payment rail, which the registry entry expresses at the agent level via
`supportedPaymentSources`. A resource entry describes *what the endpoint is and
how to call it*, never how it is paid for.

## Indexer contract

The registry indexer, for an `X402`-type entry:

1. Reads `x402ResourcesUrl` from the on-chain registry metadata (`type: "x402V1"`).
2. Fetches the manifest over HTTPS (with sane size/time limits and content-type
   `application/json`).
3. Validates each `resources[]` entry against the schema above; skips malformed
   entries rather than dropping the whole agent.
4. Stores the parsed resources in its catalog, **grouped under this agent**, so a
   caller can search Masumi's registry and get agent → resources → I/O schemas.

Payment options for calling any resource come from the same registry entry's
`supportedPaymentSources`, not from the manifest.

## Versioning

This manifest format is Masumi-defined (x402 does not standardize a per-agent
manifest). Breaking changes to the manifest shape will bump the on-chain `type`
value (`x402V1` → `x402V2`), so an indexer can dispatch on it. `x402Version`
inside the manifest tracks the *x402 protocol* version of the resources, which is
independent of the Masumi manifest version.
