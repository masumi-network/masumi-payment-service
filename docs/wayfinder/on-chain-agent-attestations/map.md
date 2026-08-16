---
title: Plan standards-based on-chain agent attestations
label: wayfinder:map
status: open
based_on: dev@7d71365b
---

## Destination

An implementation-ready protocol decision and specification for independent organizations such as PwC to attest claims about a Masumi agent, authorize the user to mint or update the agent registry asset, attach integrity-protected evidence, and let third parties verify status without depending on Veridian. Veridian/KERI/ACDC remains a supported option in the comparison and migration design.

## Notes

- Planning only. Do not implement production code in this map.
- Baseline is `dev` at `7d71365b`.
- Existing `dev` support stores KERI/ACDC issuer, schema, credential, holder, OOBI, and TEL anchors in CIP-25 registry metadata through `@masumi/payment-core/verification`.
- Research must prefer standards bodies, primary specifications, and official project documentation.
- Local tracker convention: child tickets live in `tickets/`; `status: open`, no assignee, and all `blocked_by` tickets closed means frontier. Claim by adding `assignee` before work.
- Relevant local skills when available: `wayfinder`, `grilling`, `domain-modeling`, `research`, `explain-cip`, and `design-token`.

## Decisions so far

- [Compare portable credential and signature standards](tickets/research-credential-standards.md) — Profile W3C VC 2.0 with JOSE/ES256, HTTPS issuer identifiers, explicit issuer trust, and Bitstring Status List; keep Veridian as an adapter.
- [Compare Cardano anchoring and user-mint patterns](tickets/research-cardano-standards.md) — Preserve V2 with a compact CIP-25 credential anchor first; user-submitted minting needs a new client-signing flow, while consensus enforcement needs a new policy.
- [Compare Veridian and evidence lifecycle options](tickets/research-veridian-evidence-status.md) — Keep sensitive evidence encrypted off-chain with digest binding and independent archival; preserve legacy KERI/TEL through a lossless proof-profile adapter.

## Not yet specified

- Exact regulated claim sets and jurisdictional obligations are unclear until stakeholders define whether this is organizational KYB, individual KYC, agent-control proof, assurance/audit evidence, or a mix.
- Verifier and issuer product UX, commercial issuer onboarding, and service-level requirements depend on the chosen credential exchange and status protocols.
- Migration rules for already-minted KERI-only entries depend on whether the generic envelope can losslessly wrap existing anchors.

## Out of scope

- Performing KYC/KYB or storing raw identity documents in Masumi as part of this planning effort.
- Selecting a production identity provider or negotiating with PwC.
- Implementing contracts, APIs, UI, issuer infrastructure, or a hosted document vault.
- Treating a blockchain anchor alone as proof that a real-world claim is true; issuer trust policy remains explicit.
