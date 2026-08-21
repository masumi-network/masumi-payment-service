---
title: Choose attestation enforcement boundary
label: wayfinder:grilling
status: closed
parent: ../map.md
assignee: codex
blocked_by:
  - research-cardano-standards.md
  - choose-generic-attestation-envelope.md
  - define-claim-and-issuer-policy.md
blocks:
  - bind-subject-and-authorize-mint.md
  - specify-protocol-and-conformance.md
---

## Question

Must the Cardano minting policy cryptographically require an approved issuer authorization, or does the registry remain permissionless while credentials are discoverable and trust is enforced by verifiers or a separate curated registry profile? Decide whether both modes must coexist and how they remain distinguishable.

## Resolution

Resolved 2026-08-17. `Web3CardanoV2` remains permissionless at consensus.
Registry Nodes perform off-chain credential verification and local trust
evaluation without hiding untrusted credentials or changing ledger validity.

- This decision and the new assurance protocol apply only to
  `Web3CardanoV2`. `Web3CardanoV1` remains unchanged and receives no new
  credential shape, verification workflow, or enforcement behavior.
- The V2 minting policy remains permissionless and does not validate issuer
  credentials or trust policy. A Registry Node resolves Assurance References,
  verifies credential integrity, signature, subject binding, validity, and
  status, then applies its operator's Issuer Trust Policy. The Registry Node is
  a logical role that may initially be co-located with the existing Payment
  Node; its result does not change ledger validity.
- Registry Nodes discover and return credentials independently from issuer
  trust. A valid credential from an untrusted issuer remains visible with its
  local Trust Evaluation; trust policy must not hide the on-chain Assurance
  Reference or pretend the credential does not exist.
- Registry Node results use two independent dimensions: `verificationStatus`
  is `valid`, `invalid`, or `unavailable`; `trustStatus` is `trusted`,
  `untrusted`, or `notEvaluated`. A single combined status would incorrectly
  conflate credential validity with local issuer acceptance.
