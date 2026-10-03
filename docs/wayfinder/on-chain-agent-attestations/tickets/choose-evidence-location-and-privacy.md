---
title: Choose evidence location and privacy rules
label: wayfinder:grilling
status: closed
parent: ../map.md
assignee: codex
blocked_by:
  - research-cardano-standards.md
  - research-veridian-evidence-status.md
blocks:
  - specify-protocol-and-conformance.md
---

## Question

Which evidence may be public, encrypted, selectively disclosed, or referenced only by digest; where may each class live; and what canonical digest, media type, encryption-recipient, retention, availability, and redaction rules must issuer, holder, and verifier follow?

## Resolution

Resolved 2026-08-17. All evidence remains off-chain. Sensitive packages are
encrypted using standard formats; public evidence may remain unencrypted.
Issuer-signed credentials bind exact evidence bytes and describe access, while
Cardano carries only the credential reference.

- Raw KYC/KYB documents and sensitive assessment evidence must never appear in
  Cardano metadata or the anonymously retrievable public credential. The issuer
  encrypts the exact Evidence Package before upload; the signed credential may
  contain its access URI, media type, and SHA-384 `digestSRI` over ciphertext.
  No plaintext document or plaintext-derived hash is published on chain.
- Every Evidence Package remains off-chain. An explicitly non-sensitive public
  report or certificate may be stored and retrieved without encryption, but its
  URI, media type, and SHA-384 digest exist only inside the signed Assurance
  Credential. Cardano metadata contains only the Assurance Reference to that
  credential, never a direct evidence URI, digest, or document.
- Private Evidence Packages use access-controlled HTTPS as their primary
  retrieval path and may add an encrypted `ipfs://` or `ar://` archival mirror.
  Public Evidence Packages may use public HTTPS, IPFS, or Arweave. Every copy
  must resolve to bytes matching the credential's evidence digest; a mirror is
  an availability mechanism, not an additional source of truth.
- Version 1 defines no Masumi-specific encryption envelope or recipient-grant
  protocol. Evidence metadata uses W3C VC 2.0 `evidence` and `relatedResource`
  with `id`, `mediaType`, and SHA-384 `digestSRI`. Protected HTTPS retrieval
  uses OAuth 2.0 protected-resource metadata and authorization. Portable
  encrypted packages use RFC 7516 JWE JSON Serialization with RFC 7518
  `A256GCM`; flattened form is used for one recipient and general form for
  multiple recipients. Changing JWE recipients creates new serialized bytes,
  so the issuer must publish a new evidence digest and reissue the credential
  rather than inventing a mutable out-of-band key-grant layer.
- A PDF carrying its own regulated or long-lived document signature should use
  ETSI PAdES, with B-LTA for long-term validation. This document signature is
  separate from the issuer's W3C credential signature.
- The issuer publishes an evidence-retention policy and retains each Evidence
  Package throughout the credential validity period plus any longer audit or
  regulatory period required in the applicable jurisdiction. The protocol
  does not invent one global duration; the signed credential or linked issuer
  policy identifies the applicable retention commitment.
- After lawful deletion or encryption-key destruction, the Registry Node
  reports `evidenceStatus: unavailable`. Evidence Availability is independent
  from credential status: missing evidence does not itself revoke or rewrite a
  historically signed credential, though a verifier's policy may decline to
  rely on a credential whose required evidence cannot be inspected.
