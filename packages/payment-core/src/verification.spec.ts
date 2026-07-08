import { describe, expect, it } from '@jest/globals';
import {
	parseVerificationsFromMetadata,
	verificationsSchema,
	verificationsToMetadata,
	type Verification,
} from './verification';

const sample: Verification = {
	method: 'KERI-ACDC',
	schemaVersion: '1',
	issuer: {
		aid: 'EIaIeKvfBLmZf3wfqB0oR1uM5n8m9k2pQ7rT4sV1wX3y',
		oobi: 'https://witness.example.com/oobi/EIaIeKvfBLmZf3wfqB0oR1uM5n8m9k2pQ7rT4sV1wX3y/witness',
	},
	schema: {
		said: 'EJ1gXWfzLyW2u0YY5Zb8c4d6e9f1g3h5j7k9l2m4n6p',
		oobi: 'https://schema.example.com/oobi/EJ1gXWfzLyW2u0YY5Zb8c4d6e9f1g3h5j7k9l2m4n6p',
	},
	credential: {
		said: 'EHpH79tPZoSl7VJZ7xMi3JWF4rH9wZ2ntGvKABd9N14z',
		oobi: 'https://cred.example.com/oobi/EHpH79tPZoSl7VJZ7xMi3JWF4rH9wZ2ntGvKABd9N14z',
		registry: 'ER7yQ3kL9mN2pT5vX8a1b4c7d0e3f6g9h2j5k8l1m4n7',
	},
	holder: {
		aid: 'EBcd1ef2gh3ij4kl5mn6op7qr8st9uv0wx1yz2ab3cd4',
		oobi: 'https://keria.example.com/oobi/EBcd1ef2gh3ij4kl5mn6op7qr8st9uv0wx1yz2ab3cd4/agent/EAgnt',
	},
	baseUrl: 'https://verify.example.com',
};

// Mirrors `stringToMetadata(value, forceArray=true)`: short strings become a
// single-element array, long ones split every 60 chars (CIP-25 64-byte cap).
function chunk(value: string | undefined | null): string | string[] | undefined {
	if (value == undefined) return undefined;
	const out: string[] = [];
	for (let i = 0; i < value.length; i += 60) out.push(value.slice(i, i + 60));
	return out;
}

describe('verification metadata', () => {
	it('validates a well-formed verification', () => {
		expect(verificationsSchema.safeParse([sample]).success).toBe(true);
	});

	it('round-trips through the on-chain representation (chunk -> parse)', () => {
		const onChain = verificationsToMetadata([sample], chunk);
		expect(parseVerificationsFromMetadata(onChain)).toEqual([sample]);
	});

	it('chunks long OOBI URLs into <=60-char segments and reassembles them', () => {
		const longOobi = `https://witness.example.com/oobi/${'E'.repeat(90)}/witness`;
		const withLongOobi: Verification = { ...sample, issuer: { ...sample.issuer, oobi: longOobi } };
		const onChain = verificationsToMetadata([withLongOobi], chunk);
		expect(Array.isArray(onChain[0].issuer.oobi)).toBe(true);
		expect((onChain[0].issuer.oobi as string[]).every((segment) => segment.length <= 60)).toBe(true);
		expect(parseVerificationsFromMetadata(onChain)?.[0].issuer.oobi).toBe(longOobi);
	});

	it('omits optional fields (registry/baseUrl/schemaVersion) when absent', () => {
		const minimal: Verification = {
			method: sample.method,
			issuer: sample.issuer,
			schema: sample.schema,
			credential: { said: sample.credential.said, oobi: sample.credential.oobi },
			holder: sample.holder,
		};
		const onChain = verificationsToMetadata([minimal], chunk);
		expect(onChain[0].schemaVersion).toBeUndefined();
		expect(onChain[0].credential.registry).toBeUndefined();
		expect(onChain[0].baseUrl).toBeUndefined();
		expect(parseVerificationsFromMetadata(onChain)).toEqual([minimal]);
	});

	it('returns null for malformed or missing metadata rather than throwing', () => {
		expect(parseVerificationsFromMetadata(null)).toBeNull();
		expect(parseVerificationsFromMetadata('nope')).toBeNull();
		// missing required issuer/schema/credential/holder
		expect(parseVerificationsFromMetadata([{ method: ['KERI-ACDC'] }])).toBeNull();
		// non-URL oobi fails the strict re-parse
		expect(
			parseVerificationsFromMetadata([{ ...verificationsToMetadata([sample], chunk)[0], baseUrl: ['not a url'] }]),
		).toBeNull();
	});

	it('rejects more than the maximum number of verification entries', () => {
		const many = Array.from({ length: 11 }, () => sample);
		expect(verificationsSchema.safeParse(many).success).toBe(false);
	});
});
