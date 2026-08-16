---
title: Compare Veridian and evidence lifecycle options
label: wayfinder:research
status: closed
parent: ../map.md
assignee: research-agent
blocked_by: []
blocks:
  - choose-generic-attestation-envelope.md
  - choose-evidence-location-and-privacy.md
  - define-status-and-revocation.md
---

## Question

How does the existing Veridian/KERI/ACDC approach compare with standards-based alternatives for issuer signatures, agent or holder binding, document references, independent resolution, revocation, key rotation, and long-term availability? Evaluate on-chain documents versus content-addressed external storage (including encrypted IPFS or equivalent), ordinary HTTPS, durable archives, hash/link formats, privacy and erasure risks, and status-list or registry options. Include a concrete compatibility path for current KERI anchors.

## Resolution

### Recommendation

Use a method-neutral attestation anchor, with **W3C Verifiable Credentials Data Model 2.0** as the portable credential/evidence/status model and Veridian/KERI/ACDC as one supported proof profile. Do not make Veridian, OOBI resolution, or a KERI TEL mandatory for new attestations.

For KYC/KYB and audit documents, put neither cleartext documents nor raw personal-data-derived digests directly on Cardano. The default evidence profile should be:

1. package the exact evidence bytes and metadata;
2. preserve any independent document signature (for PDF, prefer PAdES B-LT/B-LTA when long-term legal validation matters);
3. encrypt the package before upload using a standard authenticated-encryption envelope;
4. reference the encrypted bytes by one or more replaceable retrieval URIs plus a transport-neutral cryptographic digest inside the issuer-signed credential;
5. anchor only the signed credential's method-neutral identifier/digest and minimal status discovery data on chain; and
6. publish credential status through W3C Bitstring Status List v1.0, optionally checkpointing signed status-list versions on Cardano.

This separates four claims that must not be conflated:

- a document signature proves who signed a particular document representation;
- a credential signature proves who issued the attestation and protects its claims and evidence references;
- a holder/controller proof proves the presenter or minter controls the bound key or Cardano account; and
- the Cardano transaction proves who authorized the mint/update under the minting policy.

A content hash proves byte equality, not document authorship, availability, confidentiality, current credential status, or truth of the real-world claim.

### Current `dev` baseline

At `dev@7d71365b`, `@masumi/payment-core/verification` and `AgentVerification` persist and emit a KERI-specific CIP-25 block containing:

| Existing field | Meaning |
| --- | --- |
| `method` | Currently exemplified by `KERI-ACDC` |
| `issuer.aid`, `issuer.oobi` | Issuer KERI AID and KEL discovery endpoint |
| `schema.said`, `schema.oobi` | ACDC schema SAID and retrieval endpoint |
| `credential.said`, `credential.oobi` | ACDC SAID and signed/anchored artifact retrieval endpoint |
| `credential.registry` | Optional TEL/registry SAID |
| `holder.aid`, `holder.oobi` | Issuee/holder AID and KEL discovery endpoint |
| `baseUrl` | Optional KERIA/witness resolver root |

The comments correctly treat an OOBI as an untrusted locator whose returned material must be verified against AIDs/SAIDs. The current model is useful and should remain readable, but its required KERI fields prevent a non-KERI issuer from using W3C Data Integrity, JOSE/COSE, X.509, or a future proof mechanism.

### Standards and maturity comparison

| Option | Signature and identity lifecycle | Status | Evidence/document fit | Maturity and consequence |
| --- | --- | --- | --- | --- |
| **Veridian + KERI/ACDC/CESR/OOBI/TEL** | KERI maintains a stable AID across key rotation through an append-only KEL and pre-rotation. ACDC issuance/state is bound by a seal to the issuer key state rather than by directly signing the ACDC. Targeted ACDCs bind an issuee AID. Witnesses/watchers can make duplicity detectable. | TEL can model issued/revoked state and binds each state transition to issuer key state. | SAIDs give strong content integrity and ACDC chains give provenance. OOBIs discover schemas, credentials, KELs, and registries. Arbitrary evidence still needs an application profile, access control, retention, and availability policy. | KERI, ACDC, and CESR now have Trust over IP v1.1 specifications and active open-source implementations. However, the older ACDC IETF submission is an expired individual draft with no IETF standing; the standalone OOBI I-D expired in 2024. Veridian describes its first wallet release as ongoing R&D/demonstration, while also reporting audit and penetration testing. Its April 2026 integration docs still warn that deployed Signify code uses forks and that Java support is planned. Strong optional profile, weak universal dependency. |
| **W3C VC 2.0 + Data Integrity** | Issuer embeds a standardized proof, for example the W3C EdDSA cryptosuite. Holder binding is expressed by subject/holder identifiers and a signed presentation when required. Controlled Identifiers/DIDs can rotate keys, but verifiers need historical key-state access for old signatures. | W3C Bitstring Status List v1.0 supports revocation and suspension with signed, cacheable lists and herd privacy. | VC 2.0 defines `evidence` and integrity-protected `relatedResource`/evidence references using `digestSRI` or `digestMultibase`. | VC 2.0, Data Integrity, EdDSA cryptosuites, Controlled Identifiers, and Bitstring Status List are W3C Recommendations dated 15 May 2025. Broadest standards-first base here. JSON-LD/context handling remains an implementation cost. |
| **W3C VC 2.0 + JOSE/COSE** | W3C's securing specification standardizes enveloping JWS, SD-JWT, and COSE forms and supports JWK/controlled-identifier key discovery. JOSE/COSE fit common enterprise crypto and HSMs; X.509 may be used by an agreed profile. | Use W3C Bitstring Status List for VC status; certificate CRL/OCSP is separate and covers the signing certificate, not credential status. | Same VC 2.0 evidence model. JWE (RFC 7516) or COSE encryption (RFC 9052) can protect evidence packages independently of the credential representation. | The W3C JOSE/COSE VC specification is a 2025 Recommendation and underlying JOSE/COSE formats are RFCs. A pragmatic profile for an external professional-services issuer, subject to trust-registry and key-history rules. |
| **IETF SD-JWT VC + Token Status List** | Selective disclosure plus optional holder key binding (`cnf` and KB-JWT) is explicit. | Token Status List supplies privacy-preserving aggregate status for JWT, SD-JWT, CWT, and mdoc-like tokens. | Type metadata can be integrity protected, but an application evidence vocabulary/profile is still required. | As of 16 August 2026, SD-JWT VC `-18` is still an active Internet-Draft in AD evaluation; Token Status List `-21` is in the RFC Editor queue but is still an Internet-Draft. Track and support later, but do not freeze either draft as the only v1 wire format. |
| **Custom on-chain registry/status** | Cardano scripts can enforce a chosen issuer/minter authorization model. Rotation must be designed explicitly. | A UTxO or token state can be independently queried without an issuer API. | On-chain evidence is permanently public and expensive; external evidence still needs the same URI/hash/retention design. | Chain-native and independently available, but custom, privacy-sensitive, and not interoperable with standard credential wallets. Prefer as an anchor/checkpoint, not the credential or evidence protocol. |

Primary protocol facts:

- [KERI v1.1](https://trustoverip.github.io/kswg-keri-specification/) specifies AIDs, append-only KELs, pre-rotation, witnesses/watchers, seals, and OOBIs. A verifier needs the key-event history through the establishment event governing a signature.
- [ACDC v1.1](https://trustoverip.github.io/kswg-acdc-specification/) specifies targeted/untargeted containers, SAID-bound schemas, chaining/disclosure, and TEL registries. Its key-state binding section says the ACDC itself is not directly signed: a KEL/TEL seal binds ACDC state to the issuer's signed key state. A TEL may expose `issued` and `revoked` states.
- [CESR v1.1](https://trustoverip.github.io/kswg-cesr-specification/) defines the self-framing representation, qualified cryptographic material, SAIDs, and attached signatures used by the suite.
- The [expired OOBI Internet-Draft](https://trustoverip.github.io/tswg-oobi-specification/draft-ssmith-oobi.html) defines an OOBI as AID/SAID plus discovery URI; the OOBI itself is not trusted. Current KERI v1.1 also contains its own OOBI section.
- The IETF Datatracker marks [the earlier ACDC Internet-Draft](https://datatracker.ietf.org/doc/draft-ssmith-acdc/03/) “expired & archived” and expressly says it is not endorsed by the IETF.
- [Veridian's repository](https://github.com/veridian-id/veridian-wallet) calls the first release an open-source KERI-on-Cardano demonstration resulting from ongoing R&D; it reports security auditing and penetration testing. [Veridian's stack documentation](https://docs.veridian.id/stack) identifies keripy as the reference implementation and KERIA/Signify as the recommended stack, but also documents current forks and incomplete language support. This is evidence of active implementation, not proof of cross-vendor interoperability.

### Document signature versus credential signature

Keep both when an attester supplies a signed report:

- **Document layer.** A PDF signature covers the PDF's signed byte ranges and can express a natural/legal person's signing intent under the relevant certificate/trust regime. For material that must validate after certificate expiry, revocation-service disappearance, or algorithm change, request PAdES B-LT or preferably B-LTA. [ETSI EN 319 142-1](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf) defines B-LT as embedding validation material and B-LTA as adding timestamps that protect long-term availability and integrity of that material.
- **Credential layer.** The attestation credential signs claims such as “PwC performed procedure X, under policy Y, for agent Z, with result R,” plus an integrity-protected evidence reference. W3C VC 2.0 explicitly distinguishes `evidence` from the securing mechanism: evidence supports confidence in the claim; the securing mechanism proves credential issuer authenticity and credential integrity. See [VC 2.0 Evidence](https://www.w3.org/TR/vc-data-model-2.0/#evidence) and [Securing Mechanisms](https://www.w3.org/TR/vc-data-model-2.0/#securing-mechanisms).
- **Binding/minter layer.** The credential subject should identify the agent/registry identity, not merely a human-readable name. If the user must prove entitlement to mint, bind an authorized Cardano payment/stake credential or a separate controller identifier in the credential and require a fresh challenge or transaction witness. SD-JWT key binding, a VC presentation proof, and a Cardano transaction signature are alternative mechanisms at different layers; an issuer signature alone is not proof that the submitter controls the destination wallet.

If a document has no independent signature, a credential that contains its digest proves only that the issuer included that exact byte sequence as evidence. It does not prove who authored the document. Conversely, a signed PDF without an issuer-signed credential does not bind the report to a particular Masumi agent, mint action, claim vocabulary, expiry, or credential status method.

### Evidence identifiers and digest format

Use the W3C VC 2.0 shape as the semantic baseline even when the outer Cardano anchor is compact:

```json
{
  "evidence": [{
    "id": "https://evidence.example/objects/opaque-id",
    "type": ["Evidence", "EncryptedEvidencePackage"],
    "mediaType": "application/jose+json",
    "digestSRI": "sha384-<base64 digest of exact stored ciphertext bytes>"
  }]
}
```

Rules:

1. **Use an absolute URI only as a locator.** URI syntax comes from [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986). A URI is not an integrity or availability guarantee.
2. **Use `digestSRI` SHA-384 as the portable mandatory digest.** VC 2.0's [Integrity of Related Resources](https://www.w3.org/TR/vc-data-model-2.0/#integrity-of-related-resources) requires `digestSRI` or `digestMultibase`, requires a verifier to recompute it, and recommends SHA-384 as the minimum strength. This is simpler across ordinary HTTPS, archives, and IPFS gateways than treating an IPFS CID as the only digest.
3. **Permit `digestMultibase` as an additional representation.** W3C [Controlled Identifiers v1.0](https://www.w3.org/TR/cid-1.0/) standardizes a limited interoperable set of Multibase/Multihash encodings. Record algorithm and bytes, not an unexplained hex string. An optional [RFC 6920 `ni:` URI](https://www.rfc-editor.org/rfc/rfc6920) can also name bytes by hash, but adds little if `id` plus `digestSRI` is already present.
4. **Treat `ipfs://<CID>` as another locator/content address.** IPFS CIDs include codec, multihash, and DAG/chunking choices; the same source file can have a different CID under different import settings. Store the CID if IPFS is used, but also store the transport-neutral digest of the exact encrypted package bytes.
5. **Define the digest input exactly.** Digest the exact stored octet sequence, after packaging and encryption. Do not hash parsed JSON, rendered PDF content, filenames, or an unspecified canonical form. Record media type, evidence schema/profile version, encryption content type, and byte length. For multiple files, package them first; [BagIt RFC 8493](https://www.rfc-editor.org/rfc/rfc8493) provides a manifest/checksum-based archival package format.
6. **Allow multiple retrieval URIs for one digest.** A primary HTTPS URL, an independent archive URL, and an optional IPFS URI can all resolve to the same bytes. Changing mirrors must not require reissuing the credential if the digest and evidence object identity remain unchanged; mutable locator metadata therefore belongs outside the signed semantic core or must be represented as a signed locator-update record.

Hashes can disclose information. [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920) warns that a hash name can enable guessing/search of low-variation content, and [W3C Subresource Integrity](https://www.w3.org/TR/SRI/#cross-origin-data-leakage) discusses brute-force leakage. A hash of a passport scan or standardized certificate is not automatically anonymous. For private evidence, anchor a digest of randomized authenticated ciphertext, not a raw-document digest.

### Storage option analysis

| Storage | Integrity | Availability | Privacy/erasure | Use |
| --- | --- | --- | --- | --- |
| **Document bytes on Cardano** | Strong immutable inclusion after confirmation. | Excellent while the chain is available. | Worst option: public, replicated, practically non-erasable; encryption may eventually fail and metadata remains. Size/cost also poor. | Only for deliberately public, non-personal, small protocol artifacts. Never default KYC evidence. |
| **Ordinary HTTPS object store** | TLS protects transport, not a compromised origin; credential digest supplies end-to-end byte integrity. | Domain/provider/SaaS can disappear; mitigate with two independent providers, export/escrow, monitoring, and a durable archive copy. | Best access control and deletion mechanics. Requests reveal verifier access to the server. | Default for controlled evidence and credentials. Use opaque, non-guessable URLs; authorization; no PII in paths; immutable object versions. |
| **Public IPFS, cleartext** | CID gives content addressing. | Content exists only while at least one provider retains and announces it. | Public to anyone with CID, DHT/provider/request metadata public, hard to recall all copies. | Reject for KYC/KYB evidence. |
| **Public IPFS, encrypted bytes** | CID plus credential digest protects ciphertext. | Requires multiple pins/storage contracts; public gateways are not an SLA. | Plaintext protected while crypto/key control holds, but CID/provider/request metadata is public and deletion of all copies cannot be guaranteed. | Optional high-availability tier only after privacy assessment; never sole copy. Encrypt before adding. |
| **Private IPFS/content-addressed cluster** | Content addressing retained. | Operator must run/contract replicas and backups. | Better metadata control and deletion than public IPFS, but still operationally complex. | Viable equivalent to an object store where content-addressed replication is an explicit requirement. |
| **Durable regulated archive** | Fixity checks, immutable versions, and signed/timestamped records can provide strong audit history. | Strongest when governed by retention SLA, format migration, export, and independent escrow. | Retention/legal hold can conflict with erasure and must have a documented legal basis. | Required tier for evidence whose legal/audit validity must outlive issuer infrastructure. |

IPFS itself is not persistence. [IPFS persistence documentation](https://docs.ipfs.tech/concepts/persistence/) says unpinned data can be garbage-collected, third-party pinning services can disappear, and IPFS does not guarantee persistent availability. [IPFS privacy documentation](https://docs.ipfs.tech/concepts/privacy-and-encryption/) says the public DHT exposes CIDs/providers, traffic is public, and IPFS supplies transport encryption but not content encryption.

For encryption, use a profiled, versioned standard envelope such as [JWE RFC 7516](https://www.rfc-editor.org/rfc/rfc7516) or [COSE RFC 9052](https://www.rfc-editor.org/rfc/rfc9052), with an approved AEAD and algorithm registry. Use a fresh random content-encryption key and nonce per evidence package. Wrap the content key separately for each authorized recipient, keep all private/decryption keys off chain, record algorithm/profile version, and support recipient/key re-wrapping without changing plaintext. Re-encryption creates new ciphertext and therefore a new digest/evidence version.

Encryption does not solve retention by itself. Key destruction is useful risk reduction but is not proof that plaintext, keys, or decrypted copies held by recipients were erased.

### Privacy and erasure rules

The design needs a DPIA and jurisdiction-specific legal review before production KYC/KYB processing. Technical minimum:

- no raw KYC evidence, direct personal identifiers, personal filenames, access tokens, encryption keys, or raw-document digests on chain;
- keep evidence and identifying claims off chain under a declared purpose, legal basis, controller/processor allocation, geography, access policy, and retention period;
- prefer abstract claims such as assurance result, scope, policy, jurisdiction, issuer, issue/expiry time, and agent binding over source identity data;
- use randomized encryption before computing the immutable on-chain commitment, so the commitment is not directly guessable from a known document;
- support deletion of object-store copies, archive copies subject to legal hold, IPFS pins, wrapped keys, indexes, and access logs at retention expiry; publish a non-sensitive tombstone/status transition rather than trying to erase Cardano history; and
- state clearly that deletion makes evidence unavailable but cannot remove the pre-existing chain transaction or guarantee deletion of third-party copies.

The [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) defines personal data broadly, treats linkable pseudonymized data as personal data, requires minimization/storage limitation, and provides a right to erasure subject to exceptions. The EDPB's [blockchain guidance summary](https://www.edpb.europa.eu/system/files/2025-05/edpb-summary-022025-blockchains_en.pdf) recommends keeping personal data off chain, using only a cryptographic proof/commitment on chain, and setting a retention period. The final [EDPB blockchain guidelines page](https://www.edpb.europa.eu/documents/guideline/guidelines-on-processing-of-personal-data-through-blockchain-technologies_en) should control if the summary and final text differ.

An immutable hash is not categorically outside GDPR. Whether it is personal data depends on linkability and means reasonably likely to identify/single out a person. Do not promise “GDPR erasure by deleting the key”; document the residual chain commitment and obtain legal agreement that the chosen randomized commitment is non-identifying after off-chain deletion in the concrete deployment.

### Status and revocation

Credential status and signing-key status are different:

- **Credential status** answers whether the issuer still considers this attestation valid, suspended, superseded, or revoked.
- **Key status** answers whether a verification method was valid/authorized, including at the time the signature was created.
- **Evidence availability** answers whether supporting bytes can still be retrieved/decrypted; deletion does not retroactively invalidate a correctly issued credential unless policy says it must.
- **Claim freshness** is normally handled by `validUntil`, re-attestation, or refresh, not by pretending a one-time KYC result is timeless.

Recommended v1 status profile:

1. Require expiry (`validUntil`) for claims that can become stale.
2. Use [W3C Bitstring Status List v1.0](https://www.w3.org/TR/vc-bitstring-status-list/) for `revocation` and, if the business process needs a reversible state, `suspension`.
3. Serve signed lists from cacheable HTTPS/CDN locations with at least two independent mirrors. Lists should cover large populations; do not create one list/URL per credential. Both W3C Bitstring Status List and the IETF Token Status List warn that small or unique lists destroy herd privacy and that direct checks expose verifier access patterns.
4. Optionally anchor each published list version/digest on Cardano. The chain checkpoint proves publication/integrity; the signed status list remains the standard verifier input.
5. Define maximum status staleness and offline policy. A verifier result must report `valid`, `revoked`, `suspended`, `expired`, `status unavailable`, and `evidence unavailable` distinctly; fail closed for mint authorization if current status cannot be obtained.
6. Keep KERI TEL authoritative for an existing ACDC. A wrapper must not silently substitute a W3C status list and create two conflicting authorities.
7. Track [IETF Token Status List](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/) for JOSE/COSE/SD-JWT adoption after RFC publication. It is already in the RFC Editor queue as of this research, but v1 must identify its exact draft/RFC version if used before publication.

Do not use signing-key removal as credential revocation. W3C [Controlled Identifiers key rotation guidance](https://www.w3.org/TR/cid-1.0/#verification-method-rotation) says rotation does not itself invalidate old proofs, but historical key records and validity-time data can be required. Its [revocation guidance](https://www.w3.org/TR/cid-1.0/#verification-method-revocation) says revocation cannot retroactively alter previous identifier-document versions and may create ambiguity for pre-revocation signatures. Therefore:

- retain or independently archive issuer key state/version and trust-chain material used at issuance;
- give every signing key stable ID, purpose, activation, expiry, and revocation time;
- on compromise, rotate/revoke the key, assess the compromise window, revoke affected credentials explicitly, and reissue where required; and
- for KERI, archive/replicate the KEL, witness receipts, ACDC issuance proof, TEL history, schemas, and all SAID-addressed artifacts, rather than relying on one live OOBI host.

### Long-term verification record

A live URL is not a long-term validation record. At issuance/mint, store an off-chain validation bundle containing:

- exact signed credential bytes and their on-chain transaction/asset reference;
- proof suite/profile and software/profile versions;
- issuer identity/trust-policy decision and issuer key state/certificate chain as used at signing time;
- trusted timestamp or Cardano inclusion time, with its semantics stated;
- credential status response/list version and retrieval time;
- exact evidence ciphertext bytes or durable archive identifier, outer digest, encryption metadata, and authorized key-recovery procedure;
- any document signature, timestamp, certificate chain, CRL/OCSP material, and PAdES validation data; and
- schema/context/vocabulary versions and integrity digests needed to interpret the credential later.

Archive providers must define retention, legal hold, deletion, geographic replication, integrity-scan cadence, format/crypto migration, export, and provider-exit procedures. Re-timestamp/reseal before algorithms or timestamps age out. A historical status snapshot proves what was published then; it does not prove current status unless policy explicitly validates “as of” a historical time.

### Evidence tiers

| Tier | Contents and lifecycle | Suitable for |
| --- | --- | --- |
| **E0 — no disclosed evidence** | On chain: minimal credential anchor. Credential: claims, issuer, agent/controller binding, policy, expiry, status. `evidence` records only procedure/type or a private discovery handle. | Public registry display and most verifiers that need the attester's conclusion, not source documents. |
| **E1 — controlled evidence (default)** | Encrypted evidence package in access-controlled immutable HTTPS object storage; SHA-384 `digestSRI` in credential; second independent backup/archive; documented retention/deletion; monitored retrieval. | KYC/KYB evidence and ordinary external-attester reports. |
| **E2 — replicated confidential evidence** | E1 plus encrypted content-addressed replica, at least two independently operated pins/storage commitments, gateway and direct retrieval tests, metadata/privacy assessment, and an HTTPS/archive fallback. | Cases where cross-provider resilience justifies public/private IPFS operational and privacy cost. |
| **E3 — regulated long-term evidence** | E1/E2 plus PAdES B-LTA or equivalent signed-document profile, archived validation bundle, trusted timestamps, periodic revalidation/resealing, legal-hold controls, provider exit/export, and multi-decade format migration. | Audit, assurance, or regulated records requiring long-term evidentiary value. |

E1 is the recommended minimum for attached KYC evidence. E3 is required when the signed report itself must remain legally/technically verifiable after issuer systems or certificate services disappear. E2 is optional resilience, not an upgrade in legal validity or privacy.

### Lifecycle rules

1. **Prepare.** Issuer defines claim/policy/schema version and exact agent/controller binding. If a report is independently signed, validate and preserve that signature before packaging.
2. **Package and encrypt.** Create an immutable evidence package; for multiple files use a manifest such as BagIt. Encrypt with a fresh DEK and nonce. Compute digest over exact ciphertext bytes.
3. **Store.** Upload immutable ciphertext to E1+ storage. Verify every mirror by recomputing the digest. Never mint bearer access tokens or decryption material into metadata.
4. **Issue.** Issuer signs a credential containing evidence object, status entry, validity period, issuer key ID, agent subject, and controller/minter authorization claims. Evidence locators do not replace the digest.
5. **Accept/mint.** User proves control of the bound key/Cardano credential and signs the mint transaction. Mint service verifies credential proof, issuer authorization/trust, agent binding, expiry, and fresh status before building/submitting the transaction.
6. **Verify.** Resolve on-chain anchor; fetch exact credential; verify its digest; reconstruct issuer key state at signing time; verify credential proof; enforce claim/agent/holder policy; check current status; only then retrieve/decrypt evidence if authorized; verify package digest/manifest and document signature separately.
7. **Rotate/revoke.** Rotate issuer keys without changing issuer identity. Preserve historical key state. Revoke credentials explicitly when claims or compromise analysis require it. A locator outage is not revocation.
8. **Renew/supersede.** Issue a new credential/evidence version when claims, document bytes, encryption, schema, or evidence digest change. Link `supersedes`/`supersededBy`; never mutate bytes behind a digest.
9. **Retain/delete.** At retention expiry, apply legal hold rules, delete authorized off-chain copies and wrapped keys, unpin replicas, stop locator service, and record completion. Keep only the non-sensitive on-chain commitment and a status/tombstone permitted by policy.
10. **Migrate crypto/storage.** Re-encryption or repackaging creates new evidence bytes and digest, so issue a new evidence version. Archive validation material and re-timestamp before algorithm obsolescence.

### Compatibility path for current KERI anchors

Do not rewrite, reinterpret, or invalidate existing `KERI-ACDC` records.

1. **Keep the legacy reader/writer.** Existing CIP-25 `verifications` blocks and database columns remain supported. Existing agents verify exactly as today through AID/KEL, SAID, OOBI, ACDC issuance proof, and optional TEL.
2. **Add a generic envelope beside it.** A future method-neutral record should have common fields such as `profile`, `credential.id`, `credential.digest`, `issuer.id`, `subject.id`, `status`, `evidence`, and method-specific `proofParameters`. The generic design ticket decides exact names and compact encoding.
3. **Losslessly map, do not translate cryptography.** A synthesized wrapper for an existing record maps:

   | KERI field | Generic meaning |
   | --- | --- |
   | `method=KERI-ACDC` | `profile=keri-acdc-v1` |
   | `credential.said` | credential content identifier/digest in CESR SAID form |
   | `credential.oobi` | credential retrieval locator |
   | `issuer.aid` / `issuer.oobi` | issuer identifier / key-history discovery locator |
   | `holder.aid` / `holder.oobi` | subject/issuee identifier / key-history discovery locator |
   | `schema.said` / `schema.oobi` | integrity-bound schema identifier / locator |
   | `credential.registry` | KERI TEL status authority |
   | `baseUrl` | optional resolver/witness service locator |

4. **Preserve opaque method data byte-for-byte.** A new verifier dispatches `keri-acdc-v1` to the KERI verifier. It must not pretend a SAID is an SRI digest without decoding/validating the CESR derivation code, and it must not pretend TEL status is Bitstring Status List status.
5. **No mandatory on-chain rewrite.** Indexers/APIs can synthesize the method-neutral view for old assets. A user-authorized metadata update may dual-publish the wrapper later, but the wrapper must point to the same ACDC SAID and TEL. Old clients continue reading the original block.
6. **Optional bridge credential is a new attestation.** An issuer may issue a W3C VC whose `relatedResource`/evidence points to the old ACDC and SAID, or assert continuity between a KERI AID and another controlled identifier. That new signature and status are additive; they do not convert the original issuance or inherit its historical status automatically.
7. **Avoid split-brain status.** For the original ACDC, TEL remains authoritative. If a bridge VC has a W3C status list, that status governs only the bridge VC. Verifier output must show both results and their scopes.
8. **Replicate dependencies.** To survive Veridian/KERIA or OOBI-host exit, archive the ACDC, schema, KEL, witness receipts, TEL history, and CESR attachments under their existing SAIDs and expose additional locators. Integrity identities stay unchanged; only discovery changes.

This path allows current KERI anchors to remain first-class while new issuers can use W3C Data Integrity or JOSE/COSE without operating Veridian infrastructure.

### Sources

- [W3C Verifiable Credentials Data Model v2.0 — Recommendation, 15 May 2025](https://www.w3.org/TR/vc-data-model-2.0/)
- [W3C Verifiable Credential Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/)
- [W3C Data Integrity EdDSA Cryptosuites v1.0](https://www.w3.org/TR/vc-di-eddsa/)
- [W3C Securing Verifiable Credentials using JOSE and COSE](https://www.w3.org/TR/vc-jose-cose/)
- [W3C Controlled Identifiers v1.0](https://www.w3.org/TR/cid-1.0/)
- [W3C Bitstring Status List v1.0](https://www.w3.org/TR/vc-bitstring-status-list/)
- [IETF SD-JWT VC current Datatracker record](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
- [IETF Token Status List current Datatracker record](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/)
- [Trust over IP KERI v1.1](https://trustoverip.github.io/kswg-keri-specification/)
- [Trust over IP ACDC v1.1](https://trustoverip.github.io/kswg-acdc-specification/)
- [Trust over IP CESR v1.1](https://trustoverip.github.io/kswg-cesr-specification/)
- [OOBI expired Internet-Draft rendering](https://trustoverip.github.io/tswg-oobi-specification/draft-ssmith-oobi.html)
- [IETF status of expired individual ACDC draft](https://datatracker.ietf.org/doc/draft-ssmith-acdc/03/)
- [WebOfTrust keripy reference implementation](https://github.com/WebOfTrust/keripy)
- [WebOfTrust KERIA](https://github.com/WebOfTrust/keria)
- [Veridian wallet repository](https://github.com/veridian-id/veridian-wallet)
- [Veridian documentation](https://docs.veridian.id/)
- [RFC 3986 — URI Generic Syntax](https://www.rfc-editor.org/rfc/rfc3986)
- [RFC 6920 — Naming Things with Hashes](https://www.rfc-editor.org/rfc/rfc6920)
- [W3C Subresource Integrity](https://www.w3.org/TR/SRI/)
- [RFC 7516 — JSON Web Encryption](https://www.rfc-editor.org/rfc/rfc7516)
- [RFC 8493 — BagIt File Packaging Format](https://www.rfc-editor.org/rfc/rfc8493)
- [RFC 9052 — CBOR Object Signing and Encryption](https://www.rfc-editor.org/rfc/rfc9052)
- [IPFS content addressing](https://docs.ipfs.tech/concepts/content-addressing/)
- [IPFS persistence, permanence, and pinning](https://docs.ipfs.tech/concepts/persistence/)
- [IPFS privacy and encryption](https://docs.ipfs.tech/concepts/privacy-and-encryption/)
- [ETSI EN 319 142-1 V1.2.1 — PAdES baseline signatures](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf)
- [ETSI EN 319 102-1 V1.4.1 — creation and validation procedures](https://www.etsi.org/deliver/etsi_en/319100_319199/31910201/01.04.01_60/en_31910201v010401p.pdf)
- [GDPR official text](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)
- [EDPB blockchain guidance summary](https://www.edpb.europa.eu/system/files/2025-05/edpb-summary-022025-blockchains_en.pdf)
- [EDPB final blockchain guidelines page](https://www.edpb.europa.eu/documents/guideline/guidelines-on-processing-of-personal-data-through-blockchain-technologies_en)
