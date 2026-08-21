---
title: Define claim scope and issuer trust policy
label: wayfinder:grilling
status: closed
parent: ../map.md
assignee: codex
blocked_by: []
blocks:
  - bind-subject-and-authorize-mint.md
  - specify-protocol-and-conformance.md
---

## Question

What exactly may an issuer attest—legal entity, beneficial owner, operator, domain, wallet control, deployed agent code, service endpoint, audit result, or combinations—and how do verifiers decide which issuer, accreditation, assurance level, jurisdiction, and claim freshness they trust?

## Resolution

Resolved 2026-08-16. Assurance is optional and extensible. Issuers may make
claims about any supported subject, while every Registry Node operator applies
its own current, claim-specific trust policy.

- A registry entry may carry zero or more optional Assurance Claims about people,
  organizations, agents, capabilities, relationships, assessments, or
  certifications. Existing self-declared Agent Capabilities remain separate.
- One Assurance Credential may group related claims only when issuer, subject,
  assessment event, validity period, and revocation lifecycle are shared.
- Anyone may issue. Each Registry Node operator controls its local Issuer Trust
  Policy and may start from Masumi-supplied defaults.
- Trust is claim-type-specific by default. An operator may also configure an
  explicit wildcard that trusts an issuer for all claim types; this remains a
  local verifier decision and grants no on-chain protocol authority.
- Each trust rule may optionally restrict jurisdiction, assurance level,
  credential schema/version, and maximum credential age. An omitted constraint
  means the rule does not restrict that dimension; credential age is evaluated
  independently from the issuer-declared validity period.
- Trust policy is evaluated at verification time. Removing an issuer or rule
  makes matching credentials untrusted for new decisions immediately, while an
  audit record may preserve the result and policy snapshot from an earlier
  verification; policy removal does not rewrite history.
- Assurance Claim Types use stable, versioned identifiers and schemas. Masumi
  publishes a standard namespace, while issuers may publish custom namespaced
  types. Unknown types remain discoverable but are trusted only when an operator
  rule explicitly matches them or uses the all-claim-types wildcard.
- Each Assurance Credential has one primary subject. Person, organization,
  controller, and agent claims normally remain in separate credentials linked
  through stable identifiers and explicit relationship claims. Related claims
  about one subject may still share a credential under the grouping rule above.
