# Masumi Payment Service Context

## Glossary

### Agent Capability

A self-declared name and version describing a function or model an agent offers. An Agent Capability is not a third-party certification or evidence of conformance.

Avoid: certification, verification.

### Assurance Claim

An optional assertion by an issuer about a person, organization, agent, Agent Capability, or relationship. A registry entry can carry zero or more Assurance Claims; having none does not make the entry invalid.

Avoid: mandatory verification.

### Assurance Claim Type

A stable, versioned identifier and schema defining an Assurance Claim's meaning. Masumi publishes standard types, while issuers may publish namespaced custom types that remain discoverable but gain trust only through an operator's matching rule or claim-type wildcard.

Avoid: unversioned claim name, capability.

### Assurance Subject

The single primary person, organization, agent, Agent Capability, or relationship described by an Assurance Credential. Assurance Credentials about different primary subjects remain separate and may link through stable identifiers and explicit relationship claims.

Avoid: credential holder, bundled subjects.

### Assurance Credential

A signed issuer artifact containing one or more related Assurance Claims that share a subject, assessment event, validity period, and revocation lifecycle. Claims with independent lifecycles belong in separate Assurance Credentials.

Avoid: one credential for every claim, agent profile.

### Assurance Reference

A protocol-specific discovery record attached to an agent registry entry that locates or identifies an integrity-bound Assurance Credential or credential set. It is not itself a Trust Evaluation and can use KERI/ACDC, W3C VC, or another supported proof profile.

Avoid: verified claim, manifest.

### Evidence Package

One or more off-chain documents or records supporting Assurance Claims but stored separately from the public Assurance Credential. A sensitive Evidence Package is encrypted before upload and identified by a digest of its exact ciphertext; public evidence may remain unencrypted, but no evidence bytes or evidence digest appears on-chain.

Avoid: credential, on-chain document.

### Evidence Availability

The current ability to retrieve an Evidence Package whose bytes match the digest in its Assurance Credential. Unavailable or lawfully deleted evidence does not by itself revoke the credential; credential status and evidence availability remain separate results.

Avoid: credential status, evidence validity.

### Issuer Trust Policy

A Registry Node operator's editable rules for deciding which issuers are trusted for which Assurance Claim types; Masumi may supply defaults, but anyone can issue and the on-chain protocol does not confer trust. Rules may constrain jurisdiction, assurance level, schema version, or credential age; omission means unrestricted, while a claim-type wildcard explicitly trusts all claim types.

Avoid: global issuer allowlist.

### Registry Node

A service that indexes `Web3CardanoV2` agent registry entries, resolves Assurance References, validates credentials and status, and applies its operator's Issuer Trust Policy. It keeps credential discovery separate from local Trust Evaluations; neither determines whether a registry transaction is valid on Cardano.

Avoid: trusted registry, payment verifier.

### Credential Verification

The result of resolving an Assurance Reference and checking credential integrity, signature, subject binding, validity, and status. It is independent from Trust Evaluation: a credential can be cryptographically valid while its issuer remains untrusted.

Avoid: issuer trust, on-chain validity.

### Credential Lifecycle Status

The current off-chain state of an Assurance Credential, derived from its signed validity period and issuer-published status mechanism. Expiry follows time; suspension and revocation follow the referenced status service. Cardano stores only the Assurance Reference and does not carry or enforce this changing state.

Avoid: on-chain revocation, registry-token status.

### Trust Evaluation

The result of applying the current Issuer Trust Policy and credential state at a point in time. Removing an issuer or rule changes future evaluations immediately but does not rewrite recorded historical evaluations.

Avoid: permanent trust, credential validity.

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
