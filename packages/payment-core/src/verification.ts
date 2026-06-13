import { z } from './zod';

// KERI/Veridian verification metadata advertised by a registry asset.
//
// Lets ANY third party independently verify an agent's identity credential
// without trusting the issuing SaaS. The on-chain block carries only the KERI
// trust anchors (AIDs, SAIDs) plus the OOBIs (Out-Of-Band Introductions) where
// the heavy artifacts — KEL key state, the signed ACDC, the JSON schema, the
// TEL revocation registry — are fetched and hash-checked against those anchors.
// The OOBI URLs are untrusted; integrity comes from the on-chain SAIDs/AIDs.
//
// It is an array so verification is issuer-agnostic ("not only our claims"):
// multiple independent issuers may each attest, and a verifier trusts whichever
// issuer AIDs it chooses. ACDC field references below use `sad.*` notation.

export const VerificationMethod = {
	KeriAcdc: 'KERI-ACDC',
} as const;

// A CESR-encoded KERI AID or SAID (self-addressing identifier). Standard
// prefixes are 44 chars; allow headroom for longer key/derivation codes.
const keriIdentifierSchema = z.string().min(1).max(128);

// OOBI / resolver URL. KERI OOBIs are http(s) endpoints that serve verifiable
// material for the AID/SAID embedded in their path.
const oobiUrlSchema = z.string().url().max(500);

export const verificationSchema = z.object({
	method: z.string().min(1).max(40).describe('Verification method discriminator, e.g. "KERI-ACDC"'),
	schemaVersion: z.string().max(16).optional().describe('Version of this verification block'),
	issuer: z
		.object({
			aid: keriIdentifierSchema.describe('Issuer KERI AID (ACDC sad.i) — the root trust anchor'),
			oobi: oobiUrlSchema.describe('OOBI resolving the issuer KEL (key state) for signature verification'),
		})
		.describe('Credential issuer identity'),
	schema: z
		.object({
			said: keriIdentifierSchema.describe('Credential schema SAID (ACDC sad.s)'),
			oobi: oobiUrlSchema.describe('OOBI resolving the JSON schema; a verifier checks its hash equals said'),
		})
		.describe('Credential schema — the ACDC structure definition'),
	credential: z
		.object({
			said: keriIdentifierSchema.describe('Credential SAID (ACDC sad.d)'),
			oobi: oobiUrlSchema.describe('OOBI/endpoint serving the signed ACDC; a verifier checks its hash equals said'),
			registry: keriIdentifierSchema
				.optional()
				.describe('Credential status registry / TEL SAID (ACDC sad.ri) for independent revocation checks'),
		})
		.describe('The verifiable credential (ACDC)'),
	holder: z
		.object({
			aid: keriIdentifierSchema.describe('Issuee/holder KERI AID (ACDC sad.a.i)'),
			oobi: oobiUrlSchema.describe('OOBI resolving the holder KEL'),
		})
		.describe('Credential holder/issuee identity'),
	baseUrl: oobiUrlSchema
		.optional()
		.describe('Optional witness/KERIA resolver root for live key-state ("verify at time T") and TEL queries'),
});

export const verificationsSchema = z
	.array(verificationSchema)
	.max(10)
	.describe('Independent verification claims advertised by this registry entry (issuer-agnostic, multi-issuer)');

export type Verification = z.infer<typeof verificationSchema>;

// ---- on-chain (CIP-25) representation + (de)serialization ----

const metadataStringSchema = z.string().or(z.array(z.string()).min(1));

function metadataToString(value: string | string[] | undefined) {
	if (value == undefined) return undefined;
	if (typeof value === 'string') return value;
	return value.join('');
}

// Permissive reader: every leaf may be a single string or an array of <=60-char
// chunks. Reassembled into the strict `verificationSchema` shape by
// `parseVerificationsFromMetadata`.
const verificationMetadataReferenceSchema = z.object({
	aid: metadataStringSchema.optional(),
	said: metadataStringSchema.optional(),
	oobi: metadataStringSchema.optional(),
	registry: metadataStringSchema.optional(),
});

export const verificationMetadataSchema = z.object({
	method: metadataStringSchema,
	schemaVersion: metadataStringSchema.optional(),
	issuer: verificationMetadataReferenceSchema.optional(),
	schema: verificationMetadataReferenceSchema.optional(),
	credential: verificationMetadataReferenceSchema.optional(),
	holder: verificationMetadataReferenceSchema.optional(),
	baseUrl: metadataStringSchema.optional(),
});

export function parseVerificationsFromMetadata(value: unknown): Verification[] | null {
	if (value == null) {
		return null;
	}
	const parsed = z.array(verificationMetadataSchema).safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const reparsed = verificationsSchema.safeParse(
		parsed.data.map((entry) => ({
			method: metadataToString(entry.method),
			schemaVersion: metadataToString(entry.schemaVersion),
			issuer: entry.issuer
				? { aid: metadataToString(entry.issuer.aid), oobi: metadataToString(entry.issuer.oobi) }
				: undefined,
			schema: entry.schema
				? { said: metadataToString(entry.schema.said), oobi: metadataToString(entry.schema.oobi) }
				: undefined,
			credential: entry.credential
				? {
						said: metadataToString(entry.credential.said),
						oobi: metadataToString(entry.credential.oobi),
						registry: metadataToString(entry.credential.registry),
					}
				: undefined,
			holder: entry.holder
				? { aid: metadataToString(entry.holder.aid), oobi: metadataToString(entry.holder.oobi) }
				: undefined,
			baseUrl: metadataToString(entry.baseUrl),
		})),
	);
	return reparsed.success ? reparsed.data : null;
}

// Build the on-chain (CIP-25) representation from validated verifications.
// `chunk` is the caller's `stringToMetadata` (splits long strings into <=60-char
// arrays for the CIP-25 64-byte cap); passed in so V1 and V2 builders, which pin
// different mesh lines, share one emit shape without importing app `src/` here.
// Flat persisted row shape (mirrors the `AgentVerification` Prisma model). Kept
// here so the API boundary, serializer, and mint builders share one mapping
// without importing Prisma types into payment-core.
export type AgentVerificationRow = {
	method: string;
	schemaVersion: string | null;
	issuerAid: string;
	issuerOobi: string;
	schemaSaid: string;
	schemaOobi: string;
	credentialSaid: string;
	credentialOobi: string;
	credentialRegistry: string | null;
	holderAid: string;
	holderOobi: string;
	baseUrl: string | null;
};

// Validated nested verification -> flat DB row (createMany on register/update).
export function verificationToRow(verification: Verification): AgentVerificationRow {
	return {
		method: verification.method,
		schemaVersion: verification.schemaVersion ?? null,
		issuerAid: verification.issuer.aid,
		issuerOobi: verification.issuer.oobi,
		schemaSaid: verification.schema.said,
		schemaOobi: verification.schema.oobi,
		credentialSaid: verification.credential.said,
		credentialOobi: verification.credential.oobi,
		credentialRegistry: verification.credential.registry ?? null,
		holderAid: verification.holder.aid,
		holderOobi: verification.holder.oobi,
		baseUrl: verification.baseUrl ?? null,
	};
}

// Flat DB row -> nested verification (serializing responses and on-chain emit).
export function verificationRowToApi(row: AgentVerificationRow): Verification {
	return {
		method: row.method,
		...(row.schemaVersion != null ? { schemaVersion: row.schemaVersion } : {}),
		issuer: { aid: row.issuerAid, oobi: row.issuerOobi },
		schema: { said: row.schemaSaid, oobi: row.schemaOobi },
		credential: {
			said: row.credentialSaid,
			oobi: row.credentialOobi,
			...(row.credentialRegistry != null ? { registry: row.credentialRegistry } : {}),
		},
		holder: { aid: row.holderAid, oobi: row.holderOobi },
		...(row.baseUrl != null ? { baseUrl: row.baseUrl } : {}),
	};
}

export function verificationsToMetadata(
	verifications: Verification[],
	chunk: (value: string | undefined | null) => string | string[] | undefined,
) {
	return verifications.map((verification) => ({
		method: chunk(verification.method),
		schemaVersion: verification.schemaVersion != null ? chunk(verification.schemaVersion) : undefined,
		issuer: { aid: chunk(verification.issuer.aid), oobi: chunk(verification.issuer.oobi) },
		schema: { said: chunk(verification.schema.said), oobi: chunk(verification.schema.oobi) },
		credential: {
			said: chunk(verification.credential.said),
			oobi: chunk(verification.credential.oobi),
			registry: verification.credential.registry != null ? chunk(verification.credential.registry) : undefined,
		},
		holder: { aid: chunk(verification.holder.aid), oobi: chunk(verification.holder.oobi) },
		baseUrl: verification.baseUrl != null ? chunk(verification.baseUrl) : undefined,
	}));
}
