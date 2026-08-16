---
title: Compare portable credential and signature standards
label: wayfinder:research
status: closed
parent: ../map.md
research_branch: research/credential-standards
research_commit: 10d355341b365d693b6cb2839edbc770812f1a5e
blocked_by: []
blocks:
  - choose-generic-attestation-envelope.md
  - bind-subject-and-authorize-mint.md
---

## Question

Which current, implementable standards best express a third-party attestation about an AI agent or its controlling organization, carry issuer signatures, support selective disclosure or presentations where useful, and remain independently verifiable? Compare W3C Verifiable Credentials 2.0 and Data Integrity, JOSE/COSE-secured credentials, SD-JWT VC, OpenID4VCI/OpenID4VP, DIDs and non-DID issuer identifiers, ISO mdoc where relevant, and any mature entity/AI-agent credential standards. Separate credential format, signature suite, issuance, presentation, trust registry, and status concerns.

## Resolution

Resolved 2026-08-16. The standards are complementary layers, not competing
end-to-end protocols. Masumi should standardize a small profile at each layer and
keep the on-chain record format-neutral.

## Recommendation

Use this as the default interoperable profile for a PwC-like attester:

1. **Credential semantics:** W3C Verifiable Credentials Data Model (VCDM) 2.0,
   with a versioned Masumi `AgentAttestationCredential` type and JSON Schema.
   VCDM is a W3C Recommendation and already models issuer, subject, validity,
   schema, status, evidence, and integrity-protected related resources. It is a
   claims model, not a trust registry, signature algorithm, or exchange protocol.
2. **Issuer signature:** W3C VC-JOSE-COSE using JWS and an explicitly profiled
   algorithm, initially ES256 (`application/vc+jwt`). This is the lowest-friction
   enterprise choice: it is a W3C Recommendation, uses widely deployed JOSE/JWK
   tooling, and leaves a COSE encoding available if a compact binary credential is
   later needed. Data Integrity ECDSA is a valid second profile, not a mandatory
   dependency.
3. **Issuer identity and keys:** a stable HTTPS issuer URL that dereferences to a
   W3C Controlled Identifier document with an `assertionMethod` and
   `publicKeyJwk`, or to equivalent pinned issuer metadata. DIDs remain an optional
   adapter. For a conventional audited company, HTTPS plus a Masumi trust entry is
   easier to operate and legally identify than requiring a DID method. An X.509
   certificate chain can be an additional signature-key validation mechanism for
   regulated profiles; a JWK is only a key representation, and X.509 or TLS alone
   does not authorize the issuer to make a particular claim.
4. **Trust:** keep issuer authorization separate from signature verification.
   Masumi's trust policy/registry should bind an issuer identifier to accepted
   credential types, schemas, algorithms, assurance scope, jurisdictions,
   validity, and key-rotation rules. For a larger federation, OpenID Federation
   1.0 can distribute signed metadata, trust chains, and trust marks from agreed
   trust anchors. A vLEI/LEI or regulated certificate can be evidence that the
   issuer is the named legal entity, but it does not by itself grant Masumi
   attestation authority.
5. **Issuance and presentation:** use OpenID4VCI 1.0 when interoperable wallet
   issuance is needed and OpenID4VP 1.0 when a verifier needs an interactive,
   audience-bound presentation. Both are final and format-agnostic. They are not
   needed for deterministic verification of an already-published credential or
   its on-chain digest. A direct issuer API can therefore ship first without
   inventing a credential format, while OID4VCI can be added without changing the
   signed object.
6. **Status:** for the W3C profile, use W3C Bitstring Status List 1.0 for
   suspension/revocation and require a bounded credential validity interval.
   Verifiers must check status at decision time; an on-chain mint is not proof of
   continuing validity. If adopting IETF SD-JWT VC, either pin a reviewed version
   of the still-draft IETF Token Status List or use short-lived credentials until
   it is an RFC.
7. **Documents:** do not put KYC files or personal data on-chain. Put only a
   credential digest and minimal public claim commitment on-chain. VCDM 2.0's
   `evidence` can describe how the issuer reached its conclusion, while
   `relatedResource` can bind an external HTTPS, content-addressed, or encrypted
   object using `id`, `mediaType`, and `digestSRI`/`digestMultibase`. The URI is a
   retrieval hint; the digest is the integrity binding. Availability,
   authorization, encryption, retention, and erasure remain storage-policy
   concerns.

This profile gives two independent signatures with different meanings. The
attester signs the credential; the user signs the Cardano mint transaction. The
credential must bind the intended agent/controller and mint challenge, but that
exact binding belongs in the subject-and-mint decision, not in the credential
format choice.

## Layer-by-layer comparison

| Layer | Standard or option | Maturity on 2026-08-16 | What it solves | Fit and caveats |
| --- | --- | --- | --- | --- |
| Credential data model | W3C VCDM 2.0 | W3C Recommendation, 2025-05-15; VCDM 2.1 is only a 2026 Working Draft | Extensible issuer-holder-verifier claims model, credential/presentation structures, validity, schema, evidence, related resources, and status extension points | Best semantic envelope. Verification proves authenticity and currency, not truth or authorization. JSON-LD processing and custom vocabulary governance must be profiled. |
| Securing mechanism | W3C VC-JOSE-COSE | W3C Recommendation, 2025-05-15 | JWS/JWT, SD-JWT, and COSE envelopes over VCDM payloads | Best default for a TypeScript/enterprise stack. Pin media type, algorithm, canonical payload rules, key discovery, and `kid` behavior. COSE is useful for compact/binary transport but is not required merely because Cardano also uses COSE. |
| Securing mechanism | W3C Data Integrity 1.0 + ECDSA/EdDSA suites | W3C Recommendations, 2025-05-15 | Embedded `DataIntegrityProof`, verification-method URLs, proof purpose, cryptosuite agility | Sound alternative when Linked Data semantics or proof composition are required. ECDSA and EdDSA suites are final. It adds canonicalization/JSON-LD implementation surface compared with JWS. |
| Selective disclosure | W3C ECDSA-SD / BBS | ECDSA suite is a Recommendation; BBS suite is a Candidate Recommendation Draft dated 2026-04-07 | Holder-derived selective disclosures; BBS additionally targets cryptographic unlinkability | Do not make BBS mandatory yet. ECDSA-SD is final but is less broadly integrated into OpenID wallet ecosystems than SD-JWT VC. Neither helps once claims are published on-chain. |
| Credential format | IETF SD-JWT VC | Active OAuth WG Internet-Draft `-18`, revised 2026-08-03; intended Proposed Standard | JWT-native credential profile with `vct`, issuer metadata, key binding, selective disclosures, type metadata, and signature-key validation | High ecosystem momentum and used by OpenID HAIP, but not an RFC. Underlying SD-JWT is final RFC 9901; the VC profile can still change. Pilot only behind a versioned format identifier and conformance vectors. |
| Selective disclosure primitive | SD-JWT | RFC 9901, Proposed Standard, 2025-11 | Salted-digest disclosure of JSON properties/array elements and optional holder key binding | Mature primitive. Selective disclosure is not full unlinkability: invariant values, issuer, status index, disclosed claims, and signature/key patterns can still correlate presentations. |
| Issuance | OpenID4VCI 1.0 | OpenID Final, 2025-09-16 | OAuth-based credential offers, authorization/pre-authorized-code flows, proof of possession, issuer metadata, credential endpoint | Use for issuer-to-wallet interoperability. Format-agnostic and already profiles W3C VC, SD-JWT VC, and mdoc. It does not define claims or establish that an issuer is trustworthy. |
| Presentation | OpenID4VP 1.0 | OpenID Final, 2025-07-09 | OAuth-based credential requests, DCQL, same/cross-device response, nonce/audience binding, holder-bound presentations | Use when a wallet presents to a verifier. It can carry multiple credential formats. Static public on-chain verification does not require this protocol. |
| High-assurance profile | OpenID4VC HAIP 1.0 | OpenID Final, 2025-12 | Constrains OID4VCI/OID4VP, IETF SD-JWT VC, ISO mdoc, algorithms, and wallet behavior for high-assurance interoperability | Useful reference if Masumi later targets EUDI/high-assurance wallets. Its pinned SD-JWT VC and Token Status List versions remain pre-final, so HAIP finality does not make those IETF drafts final. |
| Issuer/key identifier | W3C Controlled Identifiers 1.0 | W3C Recommendation, 2025-05-15 | URL-addressed controller documents with JWK/Multikey verification methods and purpose-specific relationships | Recommended abstraction. It permits ordinary HTTPS URLs; DIDs are not required. Cache and archive historical key state, and define rotation/revocation semantics. |
| Issuer/key identifier | W3C DID Core 1.0 | W3C Recommendation, 2022-07-19 | DID syntax, DID documents, verification relationships, and method-dependent resolution | Portable and controller-centric, but the chosen DID method determines security, availability, governance, and operational cost. A DID proves identifier control, not legal identity or accreditation. |
| Issuer/key identifier | HTTPS + JWK/JWKS | JWK/JWS are IETF standards; current SD-JWT VC draft defines HTTPS issuer metadata | Familiar discovery and rotation for corporate issuers | Recommended baseline. Pin the issuer and accepted keys/trust path independently; never trust an arbitrary embedded JWK. Historical verification needs retained metadata or a transparency/archive policy. |
| Issuer/key identifier | X.509 (`x5c`) | Long-established IETF PKIX/JOSE mechanism; explicitly supported by current SD-JWT VC draft | Certificate-chain key validation and established enterprise/regulated PKI | Useful optional enterprise profile. Certificate subject/SAN and policy OIDs need explicit mapping to the credential issuer. A valid CA chain still does not prove the attested claim or its Masumi scope. |
| Trust/federation | OpenID Federation 1.0 | OpenID Final, 2026-02-17 | Signed entity statements, metadata policy, trust chains, trust anchors, and trust marks | Strong standards-based option once issuer onboarding grows beyond a small allowlist. It is not a credential status mechanism and does not replace Masumi's claim-specific acceptance policy. |
| Status | W3C Bitstring Status List 1.0 | W3C Recommendation, 2025-05-15 | Compact, cacheable, group-private revocation/suspension/status for VCDM credentials | Recommended for the VCDM profile. Cache/staple lists and define maximum staleness. A list can show credential state, not whether a linked document is still available. |
| Status | IETF Token Status List | Active OAuth WG Internet-Draft `-20`, 2026-04-20; in IESG evaluation | JWT/CWT status lists for JOSE/COSE tokens including SD-JWT VC and mdoc | Promising common mechanism, but not final. Pin exact draft semantics if used before RFC publication. |
| Organization identity | GLEIF vLEI / ISO 17442-3 | ISO standard and operational GLEIF governance/Qualified vLEI Issuer program | Cryptographically traceable legal-entity and organizational-role credentials rooted in the Global LEI System | Excellent optional evidence for the legal identity/authority of an organization or issuer. The implementation uses KERI/ACDC, so it is not a neutral replacement for the recommended VCDM envelope. Not every agent owner has or needs an LEI. |
| mdoc | ISO/IEC 18013-5 and OID4VC profiles | Published ISO standard; HAIP final | High-assurance, device-bound, selectively disclosed mobile credentials | The base standard is a mobile driving licence and the data model is namespace-oriented. It is a poor primary fit for arbitrary agent/KYB attestations and document evidence unless a target wallet/regulatory profile specifically requires mdoc. |
| Runtime/workload identity | SPIFFE SVID | Published SPIFFE specifications with multiple implementations | Short-lived X.509/JWT identities for running workloads in trust domains | Complementary proof of which workload is connecting now. It does not express an auditor's durable legal/KYC conclusion about an agent or controller. |
| Device/software attestation | IETF Entity Attestation Token | RFC 9711, Proposed Standard, 2025-04 | JWT/CWT claims about device/software state under the RATS model | Complementary evidence for execution environment or device posture. Its attestation keys and reference-value appraisal solve a different problem from organizational KYC/KYB. |
| AI-agent-specific | SD Agent / SD-JWT Agent Card | Individual Internet-Draft `draft-nandakumar-agent-sd-jwt-02`, not an adopted WG standard | Selectively disclosable A2A agent card with key binding and capability claims | Watch, do not depend on it. No mature standards-track AI-agent credential currently covers legal-entity attestation, issuer trust, evidence documents, lifecycle, and on-chain mint authorization. Define Masumi claims as a versioned VCDM type instead. |
| Existing option | Veridian KERI/ACDC | Implemented product stack; ACDC is a Trust over IP specification and vLEI uses it | Self-certifying identifiers, key-event history, schema-addressed credentials, chaining, and TEL lifecycle | Keep as an adapter/accepted credential family, not the mandatory wire format. It has strong provenance/rotation properties but materially less generic wallet and JOSE/OpenID interoperability. Detailed evidence/lifecycle comparison belongs to the dedicated Veridian ticket. |

## Important separations

### Credential format versus signature

VCDM 2.0 defines what a credential means and the required processing model. It
requires a securing mechanism but does not force one. VC-JOSE-COSE and Data
Integrity are securing mechanisms. IETF SD-JWT VC is a distinct JWT-native
credential format built on the SD-JWT primitive; it is not merely “a normal VC
with a signature.” Masumi metadata must therefore carry both a credential-format
identifier/version and a digest, rather than a field named only `signatureType`.

### Signature verification versus issuer trust

A valid signature answers “did the controller of this key sign these bytes?” It
does not answer “is this PwC?”, “was PwC authorized to attest this credential
type?”, or “is the KYC conclusion acceptable in this jurisdiction?” VCDM itself
states that verifiability does not imply truth and that verifiers apply their own
policies. Trust inputs need provenance and time semantics of their own:

- canonical issuer identifier and legal name/LEI where applicable;
- accepted credential type, schema digest/version, and assurance scope;
- accepted key-discovery mechanism and algorithms;
- accreditation/trust-mark source, effective interval, suspension, and removal;
- rules for credentials signed before issuer/key authorization ended.

OpenID Federation can distribute that policy in a federation. A simpler first
release can use an on-chain Masumi issuer registry, but it should model the same
fields so the two approaches can later interoperate.

### Issuance versus presentation versus minting

OID4VCI moves a credential from issuer to holder. OID4VP requests and transports a
presentation from holder to verifier. Neither protocol defines the Cardano mint
authorization. The mint transaction should reference a canonical digest of the
issuer-signed credential and contain the user's normal Cardano witness; the
contract/policy must separately verify whatever issuer authorization and replay
binding the protocol chooses.

### Selective disclosure versus public anchoring

Selective disclosure protects wallet presentations, not data copied to a public
ledger. The on-chain envelope must contain only claims that are safe to reveal
forever. A good design can issue two related artifacts: a minimal public agent
attestation used for the registry mint, and a richer private credential presented
through OID4VP. Do not publish hashes of predictable low-entropy PII as if hashing
made the PII anonymous.

## Detailed decision notes

### Why VCDM 2.0 plus JOSE is the baseline

- Both the semantic model and JOSE/COSE securing specification are final W3C
  Recommendations with conformance suites.
- VCDM's `credentialSubject` can identify an agent, controller organization, and
  other entities; subjects are explicitly not limited to people.
- `credentialSchema`, `evidence`, `relatedResource`, `credentialStatus`,
  `validFrom`, and `validUntil` cover the required extension points without
  inventing a whole envelope.
- JWS, JWK, ES256, HTTPS, and JSON fit common corporate HSM/KMS and TypeScript
  infrastructure. PwC-like issuers need not operate a DID network or a KERI stack.
- The same VCDM payload can later be secured with Data Integrity or COSE, while a
  protocol-neutral on-chain envelope identifies the exact format used.

The profile must still publish a fixed JSON-LD context locally, forbid unreviewed
remote contexts, hash or package its schema/context, define byte-level
canonicalization for the on-chain digest, and publish test vectors. “JSON that
looks like a VC” is not enough.

### Where SD-JWT VC fits

SD-JWT VC is the likely wallet-interoperability option when privacy-preserving
presentation becomes a requirement. Its underlying selective-disclosure primitive
is now RFC 9901, and OID4VCI/OID4VP/HAIP support it. The current VC profile remains
an active Internet-Draft, however, and revision `-18` changed details as recently
as August 2026. If piloted, Masumi should:

- identify the exact draft/media type and freeze conformance vectors;
- use holder key binding when presentation possession matters;
- keep issuer, type, validity, and status claims non-selective;
- avoid treating salted-hash disclosure as verifier-to-verifier unlinkability;
- allow reissuance/migration if the RFC changes validation or metadata rules.

For a public mint claim, a normal issuer-signed JWS is simpler and reveals no more
than an SD-JWT after the same claims are committed on-chain.

### DIDs, HTTPS, X.509, and JWK are not equivalents

- A **DID** is an identifier whose method defines resolution, updates, recovery,
  and trust assumptions. DID Core standardizes the common data model, not the
  quality of every DID method.
- An **HTTPS URL** can also be a VCDM issuer and a W3C Controlled Identifier. It
  naturally binds discovery to an organization's web domain but depends on DNS,
  Web PKI, hosting, caching, and archival controls.
- **X.509** is a certificate and chain-validation ecosystem. It can establish a
  key-to-subject/SAN binding under CA policy, with optional regulated certificate
  policy, but does not grant claim-specific attestation authority.
- A **JWK/JWKS** is a serialization of public-key material. It is not an identity
  or trust framework. The verifier must know why the issuer is allowed to publish
  or use that key.

Use HTTPS Controlled Identifiers by default, allow DID URLs and X.509 validation as
profiled alternatives, and normalize all of them into the same on-chain issuer
authorization record.

### Existing and emerging entity/agent standards

The closest mature organizational credential is GLEIF vLEI, standardized in ISO
17442-3 and operated under a qualification/governance framework. It is useful to
prove a legal entity, official role, or the legal identity of an issuer. It does
not define Masumi's agent attestation semantics. Because vLEI uses KERI/ACDC, it is
also a strong reason to keep a Veridian adapter rather than a reason to require
Veridian for every issuer.

SPIFFE and EAT can strengthen an attestation chain: SPIFFE can authenticate the
live agent workload; EAT can report measured device/software state. Neither is a
portable auditor-signed KYC/KYB credential. The 2026 SD Agent Card draft is the
most directly agent-specific proposal found, but it is an individual draft and
does not provide the legal trust, evidence, status, or on-chain authorization
model needed here.

## Risks and required controls

1. **Semantic ambiguity:** publish a Masumi-owned credential type, context, JSON
   Schema, human-readable policy, and immutable version/digest. A signature over
   ambiguous fields is still ambiguous.
2. **Historical key verification:** define key rotation, compromise, archival,
   and effective-time rules. A live JWKS or DID document can no longer show the
   key that signed an old credential.
3. **Trust confusion:** do not infer accreditation from a DID, domain, valid
   certificate, or successful signature. Evaluate the issuer against the
   claim-specific registry entry.
4. **Privacy and permanence:** never place raw evidence, personal claims,
   disclosures, decryption keys, bearer access URLs, or low-entropy PII hashes on
   Cardano. Public commitments need an explicit privacy review.
5. **Draft lock-in:** isolate IETF SD-JWT VC, Token Status List, BBS, and SD Agent
   Card behind versioned adapters. Final OpenID protocols that reference pinned
   drafts do not remove this risk.
6. **Status freshness and availability:** specify maximum list age, fail-open or
   fail-closed behavior, caching/stapling, archive expectations, and what happens
   if issuer infrastructure disappears.
7. **Algorithm/key confusion:** allowlist algorithms, reject `none`, require
   explicit media types and key purposes, validate `kid` against the authorized
   issuer, and prevent cross-format/cross-protocol replay.
8. **Document integrity versus access:** a digest detects changed bytes but does
   not make the resource durable, confidential, authorized, malware-safe, or
   legally retainable. Those controls require a separate evidence profile.

## Primary and official sources

- [W3C Verifiable Credentials Data Model v2.0](https://www.w3.org/TR/vc-data-model-2.0/)
  — Recommendation status, claims model, trust/verification distinction,
  `evidence`, and `relatedResource` integrity metadata.
- [W3C Securing Verifiable Credentials using JOSE and COSE](https://www.w3.org/TR/vc-jose-cose/)
  — Recommendation defining JWS/JWT, SD-JWT, and COSE securing of VCDM payloads.
- [W3C Verifiable Credential Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/),
  [ECDSA Cryptosuites 1.0](https://www.w3.org/TR/vc-di-ecdsa/), and
  [EdDSA Cryptosuites 1.0](https://www.w3.org/TR/vc-di-eddsa/) — final embedded
  proof framework and cryptosuites.
- [W3C Data Integrity BBS Cryptosuites 1.0](https://www.w3.org/TR/vc-di-bbs/)
  — current Candidate Recommendation Draft for unlinkable selective disclosure.
- [RFC 9901: Selective Disclosure for JSON Web Tokens](https://datatracker.ietf.org/doc/rfc9901/)
  — final SD-JWT primitive and optional key binding.
- [IETF SD-JWT-based Verifiable Digital Credentials](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
  — live status and current text of the SD-JWT VC Internet-Draft.
- [OpenID for Verifiable Credential Issuance 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0-final.html)
  and [OpenID for Verifiable Presentations 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0-final.html)
  — final, credential-format-agnostic issuance and presentation protocols.
- [OpenID4VC High Assurance Interoperability Profile 1.0](https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-1_0-final.html)
  — final profile combining OID4VCI/OID4VP with SD-JWT VC and ISO mdoc while
  identifying its pinned pre-final dependencies.
- [W3C Controlled Identifiers 1.0](https://www.w3.org/TR/controller-document/)
  and [W3C DID Core 1.0](https://www.w3.org/TR/did-core/) — URL-based controller
  documents, JWK/Multikey methods, verification relationships, and DID resolution.
- [OpenID Federation 1.0](https://openid.net/specs/openid-federation-1_0-final.html)
  — final trust chains, metadata policy, trust anchors, and trust marks.
- [W3C Bitstring Status List v1.0](https://www.w3.org/TR/vc-bitstring-status-list/)
  and [IETF Token Status List](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/)
  — final VCDM status mechanism and current JOSE/COSE status-list draft.
- [ISO/IEC 18013-5:2021](https://www.iso.org/standard/69084.html) — official ISO
  scope and assurance properties of the mobile driving licence standard.
- [RFC 9711: Entity Attestation Token](https://datatracker.ietf.org/doc/rfc9711/)
  and [SPIFFE concepts/specifications](https://spiffe.io/docs/latest/spiffe/concepts/)
  — device/software attestation and workload identity, respectively.
- [IETF SD Agent draft](https://datatracker.ietf.org/doc/draft-nandakumar-agent-sd-jwt/)
  — emerging, non-WG agent-card proposal.
- [GLEIF vLEI Ecosystem Governance Framework](https://www.gleif.org/en/organizational-identity/become-a-vlei-issuer-qvi/vlei-ecosystem-governance-framework)
  and [GLEIF vLEI overview](https://www.gleif.org/en/organizational-identity/lei-vlei/the-verifiable-lei-vlei)
  — operational legal-entity trust framework and Qualified vLEI Issuer model.
- [ISO 17442-3:2024](https://www.iso.org/standard/85628.html) — published vLEI
  standard specifying LEIs in ACDC credentials.
- [Veridian ACDC documentation](https://docs.veridian.id/protocols/acdcs) and
  [Veridian credential documentation](https://docs.veridian.id/features/credentials)
  — official current KERI/ACDC implementation behavior and lifecycle.
