---
title: Choose the generic attestation envelope
label: wayfinder:grilling
status: closed
parent: ../map.md
assignee: codex
blocked_by:
  - research-credential-standards.md
  - research-cardano-standards.md
  - research-veridian-evidence-status.md
blocks:
  - bind-subject-and-authorize-mint.md
  - define-status-and-revocation.md
  - specify-protocol-and-conformance.md
---

## Question

What protocol-neutral on-chain envelope and off-chain credential profile should Masumi standardize so multiple issuers and credential technologies can coexist, Veridian can be represented without remaining mandatory, and verifiers have one deterministic discovery and validation contract?

## Resolution

Resolved 2026-08-16. Extend the existing `verifications[]` metadata property as
a strict method-discriminated union. Preserve `KERI-ACDC` losslessly and add a
compact, publicly resolvable `W3C-VC-JOSE` version 1 reference.

This envelope extension applies only to `Web3CardanoV2` registry entries.
`Web3CardanoV1` remains unchanged.

- Evolve the existing on-chain `verifications[]` property in place as a
  method-discriminated union instead of adding a sibling manifest or assurance
  property. The property contains Assurance References; its historical name
  does not mean that an entry is trusted or verified.
- Preserve the existing `KERI-ACDC` entry shape and resolution behavior as one
  lossless union variant. Add a generic credential variant for non-KERI
  protocols.
- This is a coordinated payment-node protocol upgrade. New variants may be
  minted only after the updated parser, API, persistence model, indexer, and UI
  are released; operators are required to upgrade. Existing nodes will reject
  an array containing a non-KERI variant under the current all-or-nothing
  parser, while existing KERI-only metadata remains valid.
- Parsing remains strict and atomic: every entry must use a method and version
  supported by the node and validate against that variant's complete schema.
  One unknown, unsupported, or malformed entry invalidates the entire
  `verifications[]` value; entries are not partially accepted or surfaced as
  unsupported.
- A generic Assurance Reference contains only its method/version, compact
  digest, and retrieval locations. Issuer, subject, claim types and values,
  validity, status, signatures, and evidence or document references are not
  duplicated on chain; the digest-bound signed credential is their sole source
  of truth. The existing KERI variant retains its legacy discovery fields.
- `W3C-VC-JOSE` version 1 fixes the media type and digest algorithm, so neither
  a `mediaType` field nor SRI algorithm prefix is stored on chain. Its `digest`
  is unpadded base64url SHA-256 over the exact compact JWS bytes (43
  characters). Locations are untrusted: every successful retrieval must match
  the anchored digest before parsing or signature verification. W3C
  `digestSRI` remains appropriate inside the credential for evidence resources.
- Every generic on-chain reference must provide at least one anonymously
  retrievable location so independent nodes can verify it without holder or
  issuer authorization. The public credential contains only non-sensitive
  claims; detailed identity data, documents, and assessment evidence remain
  separate access-controlled resources referenced from the signed credential.
- A generic reference uses a required `credential.uri` for its public HTTPS
  location and an optional `credential.mirrors` list for up to two `ipfs://` or
  `ar://` URIs. This avoids verbose location wrapper objects and caps the total
  at three locations. HTTPS mutability is harmless only when the retrieved
  exact bytes match the anchored digest; mirror availability does not change
  credential validity.
- The first generic credential method is `W3C-VC-JOSE` version `1`: W3C
  Verifiable Credentials Data Model 2.0 encoded as `application/vc+jwt` and
  signed with JWS ES256. `KERI-ACDC` remains unchanged; additional signature
  algorithms or formats require a later supported method version rather than
  algorithm negotiation inside version 1.
- `W3C-VC-JOSE` version 1 requires a stable HTTPS credential `issuer` and a JWS
  `kid` resolved through issuer-controlled HTTPS JWK metadata. Signature and
  key resolution prove authorship but confer no trust: the Registry Node must
  match the canonical issuer and key against its current Issuer Trust Policy.
- New W3C entries use the field name `version`; legacy KERI entries retain
  `schemaVersion` unchanged. `version` identifies the Assurance Reference
  shape and verification profile, not the issuer's claim schema.
- Version 1 has no credential-set or manifest batching. Each on-chain entry
  references one independently signed Assurance Credential. One credential may
  carry several related claims only under the existing shared issuer, primary
  subject, assessment event, validity, and revocation-lifecycle grouping rule;
  unrelated claims must not be bundled merely to conserve metadata space.
- Retain the current maximum of ten `verifications[]` entries per registry
  version. Version 1 does not add an overflow mechanism; exceeding the limit
  requires omitting a credential from the registry or waiting for a later
  protocol extension.

## Canonical W3C reference

Logical API shape before CIP-25 string chunking:

```json
{
  "method": "W3C-VC-JOSE",
  "version": "1",
  "credential": {
    "digest": "<unpadded-base64url-sha256-of-compact-jws>",
    "uri": "https://issuer.example/credentials/123",
    "mirrors": ["ipfs://bafy...", "ar://..."]
  }
}
```

`mirrors` is optional. The serializer chunks any string that exceeds the
Cardano metadata string limit; chunking does not change the logical API value
or the exact bytes whose credential digest is calculated.
