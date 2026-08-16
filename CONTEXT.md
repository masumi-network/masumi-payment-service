# Masumi Payment Service Context

## Glossary

### Agent Capability

A self-declared name and version describing a function or model an agent offers. An Agent Capability is not a third-party certification or evidence of conformance.

Avoid: certification, verification.

### Assurance Claim

An optional assertion by an issuer about a person, organization, agent, Agent Capability, or relationship. A registry entry can carry zero or more Assurance Claims; having none does not make the entry invalid.

Avoid: mandatory verification.

### Assurance Credential

A signed issuer artifact containing one or more related Assurance Claims that share a subject, assessment event, validity period, and revocation lifecycle. Claims with independent lifecycles belong in separate Assurance Credentials.

Avoid: one credential for every claim, agent profile.

### Issuer Trust Policy

A payment node operator's editable rules for deciding which issuers are trusted for which Assurance Claims. Masumi may supply defaults, but anyone can issue a claim and the on-chain protocol does not confer trust.

Avoid: global issuer allowlist.

### Payment Source Type

The kind of configured payment source. A stable identifier of the chain plus contract family used by one [[Payment Source Module]]. Current values are `Web3CardanoV1` and `Web3CardanoV2`; future Types may target other chains or contract families.

Each Type's contract-generator package pins its own MeshSDK release independently: a Type that has on-chain deployments freezes its mesh version because `applyParamsToScript` / `resolvePlutusScriptAddress` can produce different bytes (and therefore different deployed-contract addresses) across mesh releases. V1 is pinned to `@meshsdk/core@1.9.0-beta.96`; V2 tracks the latest release because it has no on-chain legacy yet.

Avoid: version, protocol.

### Inbox Registry

The registry tree that mirrors agents discoverable via the sibling
`masumi-agent-messenger` system. Routes live under
`/api/v1/registry-inbox/...`, the corresponding DB model is
`InboxAgentRegistrationRequest`, and the on-chain registry uses a
separate minting policy from the primary `Registry` tree.

NAMING DRIFT (deferred): the sibling repo was renamed from `masumi-inbox`
to `masumi-agent-messenger`. The historical `inbox` term in this repo
(routes, DB model, code paths) was NOT renamed in lockstep — doing so is
a breaking API change for existing clients calling
`/api/v1/registry-inbox/...`. The expected target name pattern is
`messenger-registry` (matching the sibling's noun-then-action convention,
`api.masumi.inbox-agent.register`). Renaming is tracked as a follow-up
PR; the term `inbox` remains canonical in this repo until that PR ships.

Avoid (in new docs / external surface): introducing new names that
combine `inbox` with `messenger` — pick the existing `inbox` term or
wait for the rename PR. Internal mixing creates a third dialect.

### Collateral UTxO (V2)

A wallet UTxO declared as the collateral input on a Plutus-script-spending
transaction. Carries the lovelace that the ledger may slash if the script
fails phase-2 validation.

Requirements (after Conway / CIP-40):

- Lovelace floor: at least `COLLATERAL_RESERVE_LOVELACE` (currently 5 ADA)
  on the candidate UTxO, scaled per script-input count via
  `deriveTotalCollateral`.
- Asset shape: ANY. Mixed-asset (native-token-carrying) UTxOs are valid
  collateral inputs since Babbage / CIP-40. There is no "pure-ADA only"
  requirement at the ledger level, and the V2 selector does not enforce
  one — it merely prefers pure-ADA candidates for sort order to avoid
  the `collateral_return` overhead.
- Disjoint from script-spending inputs: a UTxO that is BOTH a script
  spending input AND the collateral fails phase-1. Caller must pass
  every script-spending input ref to `pickBatchCollateral`'s
  `excludeSpendingInputs`.

Mesh-SDK collateral-return invariant: every V2 batch builder MUST call
`setTotalCollateral(...)` immediately after `txInCollateral(...)`. Mesh's
internal `addCollateralReturn` is gated on `setTotalCollateral` being
set — it auto-emits the ledger-required `collateral_return` output that
refunds `(collateral input value) − totalCollateral lovelace` (preserving
all tokens) back to the wallet's change address. Skipping
`setTotalCollateral` leaves the tx without a return output and the
submission fails phase-1 with token-bearing collateral inputs. This
invariant is preserved at all four `txInCollateral` sites in
`packages/payment-source-v2/src/builders/`.

Avoid: "pure-ADA collateral" (misleading — implies a requirement the
ledger removed). Use "pure-ADA-preferred" if the preference is what's
being described.

### Intended TxHash

The deterministic tx hash computed offline from a signed tx body via
`resolveTxHash(signedTx)` BEFORE `submitTx(...)` is called. Persisted on
the shared `Transaction` row alongside `invalidHereafterSlot` so the
funding-reconciliation worker can resolve ambiguous submit outcomes
(transport error, 5xx, timeout — unknown chain outcome) by querying the
chain for this exact hash.

### Divergent TxHash

The condition where `wallet.submitTx(...)` returns a hash that does NOT
equal the previously-computed [[Intended TxHash]]. Trust rule: the
node-returned hash is authoritative (the tx IS on chain at that hash);
proceed with the node value. Investigation rule: emit `logger.error` and
bump the dedicated metric (`v2_collateral_prep_hash_divergence_total`
for the collateral-prep path, `v2_batch_submit_hash_divergence_total`
with a `service` label for the six V2 batch services). Non-zero
divergence counts indicate offline-build hash drift versus the live
mesh/cardano-node — investigate cost-model staleness, mesh-version
drift, or protocol-parameter desync.

Avoid: "wrong txHash", "tx mismatch" (both ambiguous about which side
is authoritative).

### Legacy Payment Source Type

A [[Payment Source Type]] whose contract family is in long-term maintenance. The Type remains fully supported by the service — existing deployments continue to function, new instances can still be created via the API, scheduled jobs continue to drive its state machine — but no new product-level features target it. Operators are guided toward the non-legacy Type for new agents (e.g. via the migration dialog in the admin frontend), but no deadline is enforced and no API rejection blocks new legacy-Type creation.

`Web3CardanoV1` is currently the only Legacy Payment Source Type. There is no schedule for removing legacy support; removal would require draining every on-chain UTxO under the deprecated contract address first, and the service does not pre-empt that.

Avoid: deprecated, obsolete (both imply removal that is not planned).

### Supported Payment Source

A payment option advertised by an agent registry entry. Persisted as rows in a child table of the registry record, mirroring the on-chain registry metadata. The service does not require a matching configured [[Payment Source]] row to accept or persist a Supported Payment Source — the link is informational, not enforced by foreign key.

Cardano Supported Payment Sources are identified by `chain = Cardano`, a legacy Cardano `network` value (`Mainnet` or `Preprod`), `paymentSourceType`, and `address`.

Standard x402 Supported Payment Sources are identified by `chain = EVM`, CAIP-2 `network` (`eip155:*`), `scheme = Exact`, ERC-20 `asset`, atomic `amount`, `decimals`, and `payTo`. They intentionally do not use `PaymentSourceType`, because x402 is an HTTP payment protocol rather than a Masumi Cardano escrow contract family.

The set of Supported Payment Sources on an agent registry record is the single source of truth for "does this registry entry carry payment metadata, and which kinds." An empty set means the entry has no payment metadata (formerly modelled by a separate enum value).

Avoid: payment address.

Asymmetric cross-listing rule (enforced in
`validateSupportedPaymentSourcesOrThrow`):

- A [[Payment Source Type]] that is canonical (currently
  `Web3CardanoV2`) MAY only carry Supported Payment Sources whose
  `paymentSourceType` matches itself. Listing a [[Legacy Payment Source
Type]] entry on a canonical mint is rejected at the API.
- A [[Legacy Payment Source Type]] (currently `Web3CardanoV1`) MAY
  carry Supported Payment Sources of any type, including the canonical
  one. This lets a legacy entry cross-list to the canonical type as a
  migration breadcrumb without a full re-mint.

V1 Cardano registry behavior is frozen: V1 routes silently drop supplied
Supported Payment Sources and never advertise standard x402 metadata. V2
registry entries may advertise x402 options.

### x402 Payment Rail

The standard EVM x402 rail implemented by `@masumi/payment-source-x402`.
It is separate from Cardano `PaymentSourceType` and stores its own
networks, managed EVM wallets, budgets, attempts, and settlements.

The rail has two sides. The buy side signs a payment for a 402 the
caller forwards, charges a managed wallet budget, and returns the
`X-PAYMENT` header for the caller's agent to send with its own request;
the service never fetches the resource itself. The sell side is an x402
facilitator that verifies and settles inbound payments for a registered
resource, with settlement replay bound to that source.

Internal network identifiers use CAIP-2 strings. Cardano compatibility
helpers translate public `Mainnet` / `Preprod` API schemas to
`cardano:mainnet` / `cardano:preprod`; x402 uses `eip155:*` values such
as `eip155:8453` and `eip155:84532`.

The x402 rail supports the x402 `exact` scheme. EVM ERC-20 payments use
Permit2 as the universal token path; buyer wallets must already have the
needed manual approval. The service does not sponsor approval gas.

Avoid confusing this rail with the existing Cardano
`/api/v1/payment/x402` route. That older route builds Cardano payment
transactions; it is not the standard EVM x402 HTTP payment protocol.

### Managed EVM Wallet

An encrypted private-key wallet stored in `X402EvmWallet` and used by the
standard x402 rail. Managed EVM wallets are separate from Cardano
`HotWallet` / `WalletSecret` rows. API keys with `canAdmin` can manage
wallets, network configuration, and budgets; API keys with `canPay` can
spend through a managed wallet only when their CAIP-2 chain limit and
wallet budget allow it.

### Hydra Head

One instance of the Hydra Head protocol: an L2 ledger opened, funded, closed
and finalised through L1 transactions. Belongs to exactly one
[[Hydra Relation]], and only one non-`Final` Head may exist per Relation at a
time, so Heads within a Relation are strictly sequential.

Avoid: channel, hydra channel (that is the Relation), L2 (that is the layer,
not the instance).

### Hydra Relation

The singular two-party channel between one local hot wallet and one remote
wallet, per network. A Relation is long-lived and outlives the individual
[[Hydra Head]]s opened under it.

Avoid: head, pair, counterparty (the counterparty is a participant, not the
relation).

### Head Session

One process's relationship with one [[Hydra Head]]: the per-head slot in the
connection manager that owns the serialization queues, reconnect policy, the
transport generation and the fences, plus the current *attachment* — the live
socket, provider, and the durable owner epoch it was acquired under. The slot
spans transports; the attachment comes and goes with each connect. Nothing in
a Session is a cache of the database: `initialize()` rebuilds every slot from
the durable rows on restart, and the fences have durable twins.

Avoid: connection (that is the attachment's socket), managed head (the old
implementation term).

### Local Participant

The party to a [[Hydra Head]] whose Hydra signing key this service holds.
"Local" denotes **custody of the secret**, not network locality.

Avoid: our node, nearby node, localhost node.

### Remote Participant

The counterparty to a [[Hydra Head]], known only by public material — Hydra
verification key, [[Node Cardano Key]] hash and advertised node URLs. The
service never dials a Remote Participant's node; its URLs are recorded but
unused, because peer traffic is exclusively the hydra-node's own business.

Avoid: peer node (ambiguous with the etcd peer link), external node.

### Node Cardano Key

The Cardano key pair a hydra-node uses to authorise Hydra protocol
transactions and to pay its own fees, collateral and change. Deliberately
distinct from the funding hot wallet: only its 28-byte verification-key hash
is stored by the service, so that compromise of a node host cannot reach
escrowed funds or wallet balances.

Avoid: wallet key, walletVkey, fuel wallet — `cardanoVkey` and `walletVkey`
are different keys and are equal only in the explicitly-named legacy coupled
mode.

### Hydra Host

A deployment that supervises hydra-node processes and exposes a token-gated
API for provisioning and operating them. Several Hosts may serve one payment
service; each [[Hydra Head]] is placed on exactly one Host at provisioning
time and stays there for its whole life, because its persistence directory is
not relocatable.

Avoid: hydra server, node pool, cluster (a Host is not a cluster; the etcd
cluster belongs to a single Head).

### Control Plane

The authenticated surface of a [[Hydra Host]]: fleet management plus the
proxied hydra-node client API. Reached only by the owning payment service,
never by a counterparty.

Avoid: admin api (only one of its two token tiers is administrative).

### Peer Plane

The direct node-to-node link between the two participants of a [[Hydra Head]],
carrying etcd raft traffic on a per-Head port. Public by necessity, bypasses
the [[Control Plane]] proxy, and is the only Hydra channel a counterparty ever
touches.

Avoid: peer websocket, p2p api — it is neither a WebSocket nor an HTTP API.

### Exchange Plane

The counterparty-facing surface of a [[Hydra Host]], where a [[Head Invite]] is
redeemed. Unauthenticated by design — the invite is the credential, and its
authority is a signature rather than a shared secret. It is the only Host
surface a counterparty may reach, and it is disjoint from the
[[Control Plane]]: no fleet operation, no proxied node API, no token tier.

Avoid: public api, handshake api (it terminates one exchange, not a protocol),
webhook — the counterparty calls it directly and synchronously.

### Head Offer

The signed proposal by which one operator asks the counterparty of a
[[Hydra Relation]] to open the next [[Hydra Head]], carrying the public
material both sides need before either node may boot: Hydra verification key,
[[Node Cardano Key]] hash, advertise address and the agreed periods. Signed by
the offering side's Relation wallet and verified against the wallet already
recorded on that Relation, so no shared credential is needed and a stranger
cannot open a Head.

Avoid: request, negotiation — an Offer is bound to one Relation and one Head
slot, and expires. Not to be confused with a [[Head Invite]], which precedes
the Relation rather than presupposing it.

### Head Invite

A signed, single-use capability by which an operator offers to open a
[[Hydra Head]] with a counterparty it has no [[Hydra Relation]] with yet. It
carries the issuer's full public head material — Hydra verification key,
[[Node Cardano Key]] hash, [[Advertise Address]], network and periods — signed
by the issuer's Relation wallet, plus the [[Exchange Plane]] URL at which it is
redeemed. Delivered out of band rather than over the wire, so it long outlives
a [[Head Offer]]'s minutes.

Issuing one pre-allocates the node and peer port whose material it carries;
redeeming it supplies the counterparty's material, which is what lets that node
finally boot. Because everything the recipient must trust is signed inside the
invite, redemption needs no authenticated reply.

Avoid: offer (an Offer travels between parties who already know each other),
link, token — the URL and the credential are one signed object, not two.

### Advertise Address

The externally reachable `host:port` a node publishes to its counterparty, set
by `--advertise` independently of the bind address. It is a participant
identity rather than merely a location — it names the node's etcd member and
its broadcast key — so it is fixed for a [[Hydra Head]]'s life and both sides
must configure the identical string.

Avoid: peer url, public url, listen address (the bind address is separate and
may differ).
