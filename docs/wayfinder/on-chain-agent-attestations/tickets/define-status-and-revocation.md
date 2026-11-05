---
title: Define expiry revocation and update semantics
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - choose-generic-attestation-envelope.md
  - research-veridian-evidence-status.md
blocks:
  - specify-protocol-and-conformance.md
---

## Question

How do expiry, suspension, revocation, issuer key rotation, evidence replacement, registry-asset update, and deregistration interact, and which state must be checked on-chain versus at an external standards-based status endpoint at verification time?

## Decisions

- W3C credential lifecycle remains entirely off-chain. The issuer-signed
  credential carries `validFrom`, an optional `validUntil`, and a
  `credentialStatus` reference using W3C Bitstring Status List 1.0. A Registry
  Node resolves the credential and status list when evaluating it and reports
  `valid`, `notYetValid`, `expired`, `suspended`, `revoked`, or
  `statusUnavailable` as distinct outcomes.
- Web3CardanoV2 metadata continues to store only the immutable Assurance
  Reference: the credential URI, SHA-256 digest, and optional mirrors. Changing
  suspension or revocation state does not update or remint the registry asset,
  and the V2 minting policy does not enforce credential lifecycle state.
- Suspension is a reversible issuer action. Revocation is permanent for the
  identified credential. Expiry occurs automatically after `validUntil`
  without an issuer status-list update. A revoked credential cannot be
  reinstated; the issuer must issue a new credential with a new identifier,
  signature, digest, and lifecycle.
- Normal issuer key rotation does not revoke credentials. A Registry Node
  verifies the signature using the historical public key identified by the
  credential's `kid`; issuers must keep that public key and its historical
  binding available for the credential's verification lifetime. If a signing
  key is compromised, the issuer explicitly revokes every affected credential
  through its credential-status mechanism. Removing or rotating the key alone
  is not credential revocation.
